const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const uuidv4 = require('uuid').v4;

// Starting the Websocket server.
const server = http.createServer();
const wsServer = new WebSocketServer({ server });
const port = 8000;
server.listen(port, () => {
  console.log(`WebSocket server is running on port ${port}`);
});

/////////MODBUS client/////////////
const modbus = require('jsmodbus');
const net = require('net');
const socket = new net.Socket();
const options = {
  'host': '10.36.112.92',
  'port': '102'
};
const client = new modbus.client.TCP(socket);

// Connect the Modbus TCP socket
socket.connect(options);

// Error event listener for the socket
socket.on('error', function (err) {
  console.error('Socket encountered an error:', err.message);
  // Depending on the error you might want to reconnect or handle it differently
});

let isMovementInterrupted = false; //flag for stop button

const max_error = 50; // Adjust this value as needed
const max_position = 4000; // Maximum allowed position
const min_position = 0;   // Minimum allowed position
const position1 = 1500;   // Low position
const position2 = 4000;   // High posistion

function parseSignedInt16(value) {
  if (value >= 0x8000) {
    return value - 0x10000;
  }
  return value;
}

// Async function to move a Modbus-controlled device to a target position
async function moveToTargetPosition(rawTargetPosition) {
  const targetPosition = parseSignedInt16(rawTargetPosition); // Parse the target position as signed int16
  try {
    if (targetPosition > max_position || targetPosition < min_position) {
      console.error(`Target position out of allowed range. Must be between ${min_position} and ${max_position}.`);
      return;
    }
    // Check if the device is moving
    let coil1Response = await client.readCoils(1, 1); // Coils in Modbus are 0-indexed
    let coil2Response = await client.readCoils(2, 1);
    let coil1 = coil1Response.response._body.valuesAsArray[0];
    let coil2 = coil2Response.response._body.valuesAsArray[0];

    console.log(`Current coil 1: ${coil1}`);
    console.log(`Current coil 2: ${coil2}`);

    if (coil1 || coil2) {
      console.error("Device is currently moving");
      return;
    }

    // Read servo positions
    let positions = await client.readHoldingRegisters(0, 8);
    let servoIndices = [0, 2, 4, 6];
    let servoValues = servoIndices.map(index => parseSignedInt16(positions.response._body.valuesAsArray[index]));
    let currentPosition = servoValues[0]; // Assuming first position is the current one

    if (currentPosition > max_position + max_error || currentPosition < min_position - max_error) {
      console.error(`Current position is out of the allowed range plus the error margin. Must be between ${min_position - max_error} and ${max_position + max_error}.`);
      console.log(`Servo Positions: ${servoValues.join(', ')}`); // Log the updated positions
      return;
    }

    // Check if all positions have the same value (frame is level)
    if (!servoValues.every(val => val === currentPosition)) {
      await client.writeSingleCoil(1, false); // Stop moving up
      await client.writeSingleCoil(2, false); // Stop moving down
      console.error("Frame not level");
      return;
    }

    // Check the difference
    let difference = targetPosition - currentPosition;
    if (Math.abs(difference) < max_error) {
      console.log("Target position is within acceptable range");
      return;
    }

    let moving = false;
    if (difference > 0) {
      await client.writeSingleCoil(1, true); // Move up
      moving = true;
    } else if (difference < 0) {
      await client.writeSingleCoil(2, true); // Move down
      moving = true;
    }
    while (moving && !isMovementInterrupted) {
      // Continuously read the servo position
      let updatedPositions = (await client.readHoldingRegisters(0, 8)).response._body.valuesAsArray;
      let updatedServoValues = [updatedPositions[0], updatedPositions[2], updatedPositions[4], updatedPositions[6]].map(val => parseSignedInt16(val));
      console.log(`Servo Positions: ${updatedServoValues.join(', ')}`); // Log the updated positions

      // Check if all individual positions are within the margin of error of each other
      const maxServoValue = Math.max(...updatedServoValues);
      const minServoValue = Math.min(...updatedServoValues);

      // At each iteration, you can check if the movement has been interrupted

      if (isMovementInterrupted) {
        console.log("Movement has been interrupted by the user.");
        await client.writeSingleCoil(1, false); // Stop moving up
        await client.writeSingleCoil(2, false); // Stop moving down
        moving = false;
        break; // Exit the while loop
      }

      if (maxServoValue - minServoValue > max_error) {
        await client.writeSingleCoil(1, false); // Stop moving up
        await client.writeSingleCoil(2, false); // Stop moving down
        console.error("Difference between individual servo positions exceeded the margin of error.");
        moving = false;
        continue;
      }

      // Check if any servo's position is outside of the allowed range adjusted for max_error
      if (updatedServoValues.some(val => val > max_position + max_error || val < min_position - max_error)) {
        await client.writeSingleCoil(1, false); // Stop moving up
        await client.writeSingleCoil(2, false); // Stop moving down
        console.error(`One or more servo positions are out of the allowed range plus the error margin. Must be between ${min_position - max_error} and ${max_position + max_error}.`);
        moving = false;
        continue;
      }

      let updatedDifference = targetPosition - updatedServoValues[0];

      // Check if the device has moved past the target position
      if ((difference > 0 && updatedDifference <= 0) || (difference < 0 && updatedDifference >= 0)) {
        await client.writeSingleCoil(1, false); // Stop moving up
        await client.writeSingleCoil(2, false); // Stop moving down
        moving = false;
        console.error("Overshot the target position. Adjusting...");
        // Optional: You can add code here to make finer adjustments if required.
      } else if (Math.abs(updatedDifference) < max_error) {
        await client.writeSingleCoil(1, false); // Stop moving up
        await client.writeSingleCoil(2, false); // Stop moving down
        moving = false;
      }
      isMovementInterrupted = false;

    }

    console.log("Reached target position or made the best attempt.");

  } catch (err) {
    console.error(err);
    socket.end();
  }

}

//////////////////////////////
const clients = {};
const users = {};
let userActivity = [];

var TD = 0;
var TDid = '';

// Event types
const typesDef = {
  PUBLIC_EVENT: 'public_event',
  PRIVATE_CHANGE: 'private_event',
  TD_EVENT: 'td_event'
}

function broadcastMessage(json, id) {
  const data = JSON.stringify(json);
  for (let userId in clients) {
    if (userId != id) {
      let client = clients[userId];
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };
}

setInterval(function () {
  if (TD == 0) {
    broadcastMessage({ 'TD': 'DOWN' }, TDid);
  }
  else {
    broadcastMessage({ 'TD': 'UP' }, TDid);
  }
  TD = 0;
}, 500);

function handleTD(id) {
  TD = 1;
  TDid = id;
}

function handleMessage(message, userId) {
  if (message == "TD_ping") {
    handleTD(userId);
  }
  else {
    const dataFromClient = JSON.parse(message.toString());
    console.log(dataFromClient)

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
          break;
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
  delete clients[userId];
  delete users[userId];
}

function handleConnection(id) {
  for (let userId in clients) {
    if (userId != id) {
      let client = clients[userId];
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          "new_connection": 1
        }
        ));
      }
    }
  };
}

// New connection received
wsServer.on('connection', function (connection) {
  const userId = uuidv4();
  console.log('Recieved a new connection');
  clients[userId] = connection;
  console.log(`${userId} connected.`);
  handleConnection(userId);
  //Message received
  connection.on('message', (message) => handleMessage(message, userId));
  //Connection closed
  connection.on('close', () => handleDisconnect(userId));

});


// When the server is closing close the Modbus socket as well
server.on('close', function () {
  console.log('Server is shutting down, closing Modbus TCP socket.');
  socket.end();
});