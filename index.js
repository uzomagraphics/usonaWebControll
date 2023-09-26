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
