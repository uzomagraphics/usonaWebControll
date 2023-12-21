const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const uuidv4 = require('uuid').v4;
const { exec } = require('child_process');
require('log-timestamp');

////// Crestron Integration //////
const dgram = require('dgram');
const crestronIP = '10.36.112.69';
const crestronPort = 60000;
const crestronClient = dgram.createSocket('udp4');

function sendCrestronMessage(messageString) {
  const messageWithNewline = `${messageString}\x0D`;
  const messageBuffer = Buffer.from(messageWithNewline);

  crestronClient.send(messageBuffer, 0, messageBuffer.length, crestronPort, crestronIP, (err) => {
    if (err) {
      console.error(`Error sending message to ${crestronIP}:${crestronPort}: ${err}`);
    } else {
      console.log(`Message sent to ${crestronIP}:${crestronPort}: ${messageString}`);
    }
  });
}

///////// MODBUS client (HMI is modbus Server) /////////////
/// Todo open and close modbus socket when making a movement and also turn on and off the contactor
const modbus = require('jsmodbus');
const net = require('net');
const modbusSocket = new net.Socket();
const options = {
  'host': '10.36.112.92', //IP of HMI
  'port': '102'
};
const modbusClient = new modbus.client.TCP(modbusSocket);

// Connect the Modbus TCP socket
modbusSocket.connect(options);

// Error event listener for the modbusSocket
modbusSocket.on('error', function (err) {
  console.error('Modbus Socket encountered an error:', err.message);
  console.log('Attempting to reconnect every 20 seconds...');
  modbusSocket.connect(options);
});

let isMovementInterrupted = false; //flag for stop button

const max_error = 200; // Adjust this value as needed
const max_position = 42600; // Maximum allowed position
const min_position = 21570;   // Minimum allowed position
const position1 = 42500;   // Low position
const position2 = 21580;   // High posistion

// Function to parse a signed int16 value from a Modbus response
function parseSignedInt16(value) {
  if (value >= 0xb000) {
    return value - 0x10000;
  }
  return value;
}

// Async function to move a Modbus-controlled device to a target position
async function moveToTargetPosition(rawTargetPosition) {
  const targetPosition = parseSignedInt16(rawTargetPosition); // Parse the target position as signed int16
  console.log(`Target position: ${targetPosition}`);

  try {
    // Check if the target position is outside of the allowed range adjusted for max_error is so exit the function
    if (targetPosition > max_position + max_error || targetPosition < min_position - max_error) {
      console.error(`Target position out of allowed range. Must be between ${min_position} and ${max_position}.`);
      return;
    }

    // Check if the device is moving by checking the values of the up and down buttons on HMI
    // Coils in Modbus are 0-indexed and coil 0 is the dangerous "auto" button
    let coil1Response = await modbusClient.readCoils(1, 1);
    let coil2Response = await modbusClient.readCoils(2, 1);
    let coil1 = coil1Response.response._body.valuesAsArray[0];
    let coil2 = coil2Response.response._body.valuesAsArray[0];

    console.log(`Current coil 1: ${coil1}`);
    console.log(`Current coil 2: ${coil2}`);

    // If the up or down button is pressed, exit the function
    // Do not start a new movement before the current one is finished (async function)
    if (coil1 || coil2) {
      console.error("Device is currently moving. Not starting a new movement.");
      return;
    }
    let moving = false;

    // Checks passed, start moving...

    // Read current servo positions
    let positions = await modbusClient.readHoldingRegisters(0, 8);
    let servoIndices = [0, 2, 4, 6]; //every other register is a servo position the ones we skipped are the sign of the uint16s but we handle this with our parsing function with a cutoff threshold of 0xb000
    let servoValues = servoIndices.map(index => parseSignedInt16(positions.response._body.valuesAsArray[index])); // Parse the servo positions as signed int16
    console.log(`Servo Positions: ${servoValues.join(', ')}`); // Log the current positions
    let currentPosition = servoValues[0]; //store the current position of the first servo


    // Check if first servo's current position is outside of the allowed range adjusted for max_error
    // Instead of just checking the currentof one we could do any on the servo values
    if (currentPosition > max_position + max_error || currentPosition < min_position - max_error) {
      console.error(`Current position is out of the allowed range plus the error margin. Must be between ${min_position - max_error} and ${max_position + max_error}.`);
      return;
    }

    // Check if all positions have the same value (frame is level)
    // Should this be higher up in the function?
    if (!servoValues.every(val => val === currentPosition)) {
      console.error("Frame not level. Servo positions are not equal. Sending stop command.");
      await stopMotors();
      return;
    }

    // Check the difference between the target position and the current position and exit the function if it is within the margin of error
    let difference = targetPosition - currentPosition;
    if (Math.abs(difference) < max_error) {
      console.log("Target position is close enough to the current position. Not moving. We are already there.");
      return;
    }

    // Check if the target position is higher or lower than the current position and move accordingly
    if (difference > 0 && !isMovementInterrupted) {
      await modbusClient.writeSingleCoil(1, true); // Move up
      moving = true;
    } else if (difference < 0) {
      await modbusClient.writeSingleCoil(2, true); // Move down
      moving = true;
    }

    // While the device is moving, continuously read the servo positions and check if the movement has been flagged for interruption
    while (moving) {
      // At each iteration can check if the movement has been flagged for interruption
      if (isMovementInterrupted) {
        console.log("Movement has been interrupted by the user.");
        await stopMotors();
        isMovementInterrupted = false; // Reset the flag
        break; // Exit the while loop
      }

      // Continuously read the servo position
      let updatedPositions = (await modbusClient.readHoldingRegisters(0, 8)).response._body.valuesAsArray;
      let updatedServoValues = [updatedPositions[0], updatedPositions[2], updatedPositions[4], updatedPositions[6]].map(val => parseSignedInt16(val));
      console.log(`Servo Positions: ${updatedServoValues.join(', ')}`); // Log the updated positions

      // Collect the max and min servo values
      const maxServoValue = Math.max(...updatedServoValues);
      const minServoValue = Math.min(...updatedServoValues);

      // Check if the difference between the max and min servo values is greater than the margin of error
      // this is another check to see if the frame is level
      if (maxServoValue - minServoValue > max_error) {
        console.error("Difference between individual servo positions exceeded the margin of error. Not level. Sending stop command.");
        await stopMotors();
        break;
      }

      // Check if any servo position is outside of the allowed range
      if (updatedServoValues.some(val => val > max_position + max_error || val < min_position - max_error)) {
        console.error(`One or more servo positions are out of the allowed range plus the error margin. Must be between ${min_position - max_error} and ${max_position + max_error}.`);
        await stopMotors();
        break;
      }

      // store the difference between the target position and the current position of the first servo
      let updatedDifference = targetPosition - updatedServoValues[0];

      // Check if the device has moved past the target position
      if ((difference > 0 && updatedDifference <= 0) || (difference < 0 && updatedDifference >= 0)) {
        console.error("Overshot the target position. Stopping...");
        await stopMotors();
        break;
      } else if (Math.abs(updatedDifference) < max_error) { // Check if the device is close enough to the target position
        console.log("Reached target position or close enough within max error. Stopping...");
        await stopMotors();
        break;
      }
    }

    // just in case the while loop is exited without stopping the motors
    await stopMotors();

  } catch (err) {
    console.error(err);
    await stopMotors();
  }
}

////// End of Modbus client //////


////// Starting the Websocket server //////
const server = http.createServer();
const wsServer = new WebSocketServer({ server });
const port = 8000;
server.listen(port, () => {
  console.log(`WebSocket server is running on port ${port}`);
});

const webSocketClients = {}; //object to store the websocket clients
const users = {}; //object to store the users... what is diference between clients and users?
let userActivity = []; //array to store the user activity... what is user activity?

var TDStatus = 0; //flag for TDStatus ping
var TDid = ''; //id of the user that pinged
let brightness = 100; //brightness of the sconces
let lightsOn = true; // sconces on or off

// Event types and definitions for the websocket server
// Not sure what this is for
const typesDef = {
  PUBLIC_EVENT: 'public_event',
  PRIVATE_CHANGE: 'private_event',
  TD_EVENT: 'td_event'
}

// Broadcast a message to all connected clients except the sender
function broadcastMessage(json, id) {
  const data = JSON.stringify(json);
  // if if json is {"TD":"DOWN"} dont log it
  if (data != '{"TD":"DOWN"}') {
    if (data != '{"TD":"UP"}') {
      console.log(`Broadcasting message to all clients: ${data} except ${id}`);
    }
  }
  for (let userId in webSocketClients) {
    if (userId != id) {
      let webSocketClient = webSocketClients[userId];
      if (webSocketClient.readyState === WebSocket.OPEN) {
        webSocketClient.send(data);
      }
    }
  };
}

// function to send td status to all clients every 500ms
setInterval(function () {
  if (TDStatus == 0) {
    broadcastMessage({ 'TD': 'DOWN' }, TDid);
  }
  else {
    broadcastMessage({ 'TD': 'UP' }, TDid);
  }
  TDStatus = 0;
}, 500);

// Handle incoming messages from clients
async function handleMessage(message, userId) {
  // handle TDStatus ping
  if (message == "TD_ping") {
    //console.log("TD ping received");
    TDStatus = 1;
    TDid = userId;
  }

  else {
    //
    console.log(`Received message from ${userId}: ${message}`);

    const dataFromClient = JSON.parse(message.toString());
    // console.log(dataFromClient)

    ///////////MODBUS///////////////
    if (dataFromClient.motor) {
      switch (dataFromClient.motor) {
        case 1:
          moveToTargetPosition(position1)
          break;
        case 2:
          moveToTargetPosition(position2)
          break;
        case 3:
          isMovementInterrupted = true;
          console.log("Movement interrupt flag set to true");
          break;
      }
    }

    ///////////Login/////////
    if (dataFromClient.password === '1978') {
      broadcastMessage({ 'login': 'correct' });
      console.log('Correct password entered.');
    }

    /////////REBOOT/////////
    if (dataFromClient.action === 'reboot') {
      // Log the reboot action
      console.log('Reboot command received.');
      // Use the appropriate command for your operating system
      // For Unix-like systems: 'sudo /sbin/shutdown -r now'
      // For Windows: 'shutdown /r /t 0'
      exec('shutdown /r /t 0', (error, stdout, stderr) => {
        if (error) {
          console.error(`Reboot failed: ${error}`);
          return;
        }
        console.log(`Reboot initiated: ${stdout}`);
      });
      return; // Early return to prevent further processing
    }

    ///////////Crestron///////////////
    if (dataFromClient.crestronButton) {
      switch (dataFromClient.crestronButton) {
        case 1:
          sendCrestronMessage('CUSTOM_PRESET_1_GO');
          break;
        case 2:
          sendCrestronMessage('CUSTOM_PRESET_2_GO');
          break;
        case 3:
          sendCrestronMessage('SHADES_UP_GO');
          break;
        case 4:
          sendCrestronMessage('SHADES_DOWN_GO');
          break;
      }
    }

    //Sconce//
    if (dataFromClient.onOff) {
      if (dataFromClient.onOff == "ON") {
        sendCrestronMessage(`SCONCES_${brightness}%_GO`);
      }
      else {
        sendCrestronMessage(`SCONCES_0%_GO`);
      }
    }

    if (dataFromClient.lightBrightness) {
      brightness = dataFromClient.lightBrightness * 100;
      if (lightsOn) sendCrestronMessage(`SCONCES_${brightness}%_GO`);
    }

    //Motor//
    if (dataFromClient.motorOnOff) {
      if (dataFromClient.motorOnOff == "ON") {
        sendCrestronMessage(`LIFT_ON_GO`);
      }
      else {
        sendCrestronMessage(`LIFT_OFF_GO`);
      }
    }

    broadcastMessage(dataFromClient, userId);
  }

}

function handleDisconnect(userId) {
  console.log(`${userId} disconnected.`);
  const json = { type: typesDef.USER_EVENT };
  const username = users[userId]?.username || userId;
  userActivity.push(`${username} left the document`);
  json.data = { users, userActivity };
  delete webSocketClients[userId];
  delete users[userId];
}

function handleConnection(id) {
  for (let userId in webSocketClients) {
    if (userId != id) {
      let webSocketClient = webSocketClients[userId];
      if (webSocketClient.readyState === WebSocket.OPEN) {
        webSocketClient.send(JSON.stringify({
          "new_connection": 1
        }
        ));
      }
    }
  };
}

// New connection received
wsServer.on('connection', function (connection) {
  const ip = connection._socket.remoteAddress;
  console.log(`New connection from ${ip}`);
  const userId = uuidv4();
  console.log('Recieved a new connection');
  webSocketClients[userId] = connection;
  console.log(`${userId} connected.`);
  handleConnection(userId);
  //Message received
  connection.on('message', (message) => handleMessage(message, userId));
  //Connection closed
  connection.on('close', () => handleDisconnect(userId));
});


// When the server is closing close the Modbus modbusSocket as well
server.on('close', function () {
  console.log('Server is shutting down, closing Modbus TCP modbusSocket.');
  modbusSocket.end();
  //contactor off
});

// Function to stop the motors
async function stopMotors() {
  try {
    await modbusClient.writeSingleCoil(1, false); // Stop moving up
    await modbusClient.writeSingleCoil(2, false); // Stop moving down
    moving = false;
    console.log('Motors stopped successfully.');
  } catch (err) {
    console.error('Failed to stop motors:', err);

    //cut off power to the motors
  }
}

// Handle uncaught exceptions to stop the motors before crashing
process.on('uncaughtException', async (err) => {
  console.error('There was an uncaught error', err);
  await stopMotors();
  //contactor off
  process.exit(1); // exit your app
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully');
  await stopMotors();
  //contactor off
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
