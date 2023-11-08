const modbus = require('jsmodbus');
const net = require('net');
const socket = new net.Socket();
const options = {
  'host': '10.36.112.92',
  'port': '102'
};
const client = new modbus.client.TCP(socket);

const max_error = 50; // Adjust this value as needed
const max_position = 1000; // Maximum allowed position
const min_position = 0;   // Minimum allowed position

function parseSignedInt16(value) {
  if (value >= 0x8000) {
    return value - 0x10000;
  }
  return value;
}

async function moveToTargetPosition(targetPosition) {
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
    while (moving) {
      // Continuously read the servo position
      let updatedPositions = (await client.readHoldingRegisters(0, 8)).response._body.valuesAsArray;
      let updatedServoValues = [updatedPositions[0], updatedPositions[2], updatedPositions[4], updatedPositions[6]].map(val => parseSignedInt16(val));
      console.log(`Servo Positions: ${updatedServoValues.join(', ')}`); // Log the updated positions

      // Check if all individual positions are within the margin of error of each other
      const maxServoValue = Math.max(...updatedServoValues);
      const minServoValue = Math.min(...updatedServoValues);
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
    }

    console.log("Reached target position or made the best attempt.");

  } catch (err) {
    console.error(err);
    socket.end();
  }
}

socket.on('connect', async function () {
  // Grab the target position from the command line arguments
  const target = process.argv[2]; // Assumes the format is "move ###"
  // Extract the target position from the command
  const targetPosition = parseInt(target.split(' ')[1], 10);
  await moveToTargetPosition(targetPosition);
  socket.end();
});

// Process command line arguments
const command = process.argv[2]; // Node index.js command
if (command && command.startsWith('move ')) {
  socket.connect(options);
} else {
  console.log('Usage: node index.js "move ###"');
}
