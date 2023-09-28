const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const uuidv4 = require('uuid').v4;

// Starting the server.
const server = http.createServer();
const wsServer = new WebSocketServer({ server });
const port = 8000;
server.listen(port, () => {
  console.log(`WebSocket server is running on port ${port}`);
});

/////////MODBUS/////////////
const net = require('net');
const modbus = require('jsmodbus');
const netServer = new net.Server();
const netPort = 502;
const ModbusServer = new modbus.server.TCP(netServer, {

});

ModbusServer.on('connection', (client) => {
  console.log('Modbus connection successful')
});
/*
I think this will print the servo messages
*/
ModbusServer.on('postWriteMultipleRegisters', (value) => {
  console.log('Write multiple registers: ',value._body)
});

netServer.listen(netPort, () => {
  console.log(`NetServer is running on port ${netPort}`);
});

function modbusButton1() {
  /*
I think this is how we send messages
*/
  //ModbusServer.holding.writeUInt16BE(1,8)
  console.log("Modbus button 1");
}

function modbusButton2() {
  console.log("Modbus button 2");
}

function modbusButton3() {
  console.log("Modbus button 3");
}

function modbusButton4() {
  console.log("Modbus button 4");
}

function modbusButton5() {
  console.log("Modbus button 5");
}

function modbusSlider1(mbs){
  console.log("Modbus Slider 1 = " + mbs);
}

function modbusSlider2(mbs){
  console.log("Modbus Slider 2 = " + mbs);
}

/////////BACNET/////////////

function bacnetButton1() {
  console.log("Bacnet button 1");
}

function bacnetButton2() {
  console.log("Bacnet button 2");
}

function bacnetButton3() {
  console.log("Bacnet button 3");
}

function bacnetButton4() {
  console.log("Bacnet button 4");
}

function bacnetButton5() {
  console.log("Bacnet button 5");
}

function bacnetSlider1(bns){
  console.log("Bacnet Slider 1 = " + bns);
}

function bacnetSlider2(bns){
  console.log("Bacnet Slider 2 = " + bns);
}

//////////////////////////////
const clients = {};
const users = {};
let userActivity = [];

// Event types
const typesDef = {
  PUBLIC_EVENT: 'public_event',
  PRIVATE_CHANGE: 'private_event',
  TD_EVENT: 'td_event'
}

function broadcastMessage(json, id) {
  const data = JSON.stringify(json);
  for(let userId in clients) {
    if (userId != id){
      let client = clients[userId];
      if(client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };
}

function handleMessage(message, userId) {
  if (message == "pong"){
    console.log("Pong received")
  }
  else{
    const dataFromClient = JSON.parse(message.toString());
    console.log(dataFromClient)
    ///////////MODBUS///////////////
    if (dataFromClient.modbusButton){
      switch (dataFromClient.modbusButton) {
        case 1 :
          modbusButton1();
          break;
        case 2 :
          modbusButton2();
          break;
        case 3 :
          modbusButton3();
          break;
        case 4 :
          modbusButton4();
          break;
        case 5 :
          modbusButton5();
          break;
      }
    }
    else if (dataFromClient.type == "modbusSlider1") {
      modbusSlider1(dataFromClient.modbusSlider);
    }
    else if (dataFromClient.type == "modbusSlider2") {
      modbusSlider2(dataFromClient.modbusSlider);
    }
    ///////////BACNET///////////////
    else if (dataFromClient.bacnetButton){
      switch (dataFromClient.bacnetButton) {
        case 1 :
          bacnetButton1();
          break;
        case 2 :
          bacnetButton2();
          break;
        case 3 :
          bacnetButton3();
          break;
        case 4 :
          bacnetButton4();
          break;
        case 5 :
          bacnetButton5();
          break;
      }
    }
    else if (dataFromClient.type == "bacnetSlider1") {
      bacnetSlider1(dataFromClient.bacnetSlider);
    }
    else if (dataFromClient.type == "bacnetSlider2") {
      bacnetSlider2(dataFromClient.bacnetSlider);
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

// New connection received
wsServer.on('connection', function(connection) {
  const userId = uuidv4();
  console.log('Recieved a new connection');
  clients[userId] = connection;
  console.log(`${userId} connected.`);
  //Message received
  connection.on('message', (message) => handleMessage(message, userId));
  //Connection closed
  connection.on('close', () => handleDisconnect(userId));

  //keepServerAlive();
});


/**
 * Sends a ping message to all connected clients every 50 seconds
 */
/*const keepServerAlive = () => {
  keepAliveId = setInterval(() => {
    for(let userId in clients) {
      if (userId){
        let client = clients[userId];
        if(client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            "ping" : "ping"}));
        }
      }
    };
    console.log("sent ping")
  }, 50000);
};
*/
