require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const RateLimit = require('express-rate-limit');
const helpers = require('./helpers');
const jwt = require('jsonwebtoken');
const firebaseAuth = require('firebase/auth');
const MatchmakingAPI = require('./routers/matchmaking');
const middleware = require('./middleware');

const WebSocketV2_MessageTemplate = {
     data: {},
     code: "string"
};

const app = express();
app.set('trust proxy', 1);

var GlobalLimiter = RateLimit({
     windowMs: 1*60*1000,
     max: 100,
     standardHeaders: true,
     legacyHeaders: false
});

app.use(GlobalLimiter);

app.use(express.json({
     limit: '50mb'
}));
app.use(fileUpload({
     createParentPath: true,
     limit: '50mb'
}));

const config = require('./config.json');

//#region routers

// /api/accounts/*
app.use("/api/accounts", require("./routers/accounts"));
// /api/auth/*
app.use("/api/auth", require('./routers/auth'));
// /dev/*
app.use("/dev", require('./routers/dev'));
// /api/global/*
app.use("/api/global", require('./routers/global'));
// /api/notifications/*
app.use("/api/notifications", require('./routers/notifications'));
// /img/*
app.use("/img", require('./routers/img'));
// /api/analytics/*
app.use("/api/analytics", require('./routers/analytics'));
// /api/social/*
app.use("/api/social", require('./routers/social'));
// /api/econ/*
const econ = require('./routers/econ');
app.use("/api/econ", econ.router);
// /api/matchmaking/*
const matchmaking = require('./routers/matchmaking')
app.use("/api/matchmaking", matchmaking.router);
// /api/rooms/*
const RoomsAPI = require('./routers/rooms');
app.use("/api/rooms", RoomsAPI.router);
// /api/messaging/*
const messaging = require('./routers/messages');
app.use("/api/messaging", messaging.router);


//#endregion

//#region Miscellaneous Endpoints

//Server test call
app.get("/", async (req, res) => {
     return res.status(200).send("Pong!");
});

//Joke
app.get("/api/dingus", async(req, res) => {
     return res.status(200).send("You have ascended");
     //hmm
});



//#endregion

const server = app.listen(config.PORT, '0.0.0.0');
helpers.auditLog("Server Init");
console.log(`API is ready at http://localhost:${config.PORT}/ \n:D`);

var ws_connected_clients = {};

const WebSocket = require('ws');
const wss_v1 = new WebSocket.Server({ server: server, path: '/ws', 'handleProtocols': true, 'skipUTF8Validation': true },()=>{    
     console.log('server started')
});
wss_v1.on('connection', async (ws, request) => {
     var ignore_connection_closed = false;
     var tokenData;
     var location = {
          RoomId: null,
          JoinCode: null
     };

     console.log("User connected to websocket, awaiting authorization.");

     ws.on('message', async (data) => {
          data = data.toString('utf-8');
          if(data.slice(0, 7) == "Bearer " && typeof tokenData === 'undefined') {
               var token = data.slice(7);
               try {
                    tokenData = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

                    const playerData = helpers.PullPlayerData(tokenData.id);

                    for (let index = 0; index < playerData.auth.bans.length; index++) {
                         const element = playerData.auth.bans[index];
                         
                         if(element.endTS > Date.now()) {
                              //user is banned
                              ws.send("BANNED");
                              ignore_connection_closed = true;
                              ws.terminate();
                              return;
                         }
                    }
               } catch (ex) {
                    ws.send("UNAUTHORIZED");
                    ws.terminate();
                    return;
               }

               if(Object.keys(ws_connected_clients).includes(tokenData.id)) {
                    ignore_connection_closed = true;
                    ws.send("DUPLICATE CONNECTION");
                    ws.terminate();
                    return;
               }

               ws_connected_clients[tokenData.id] = 
               {
                    socket: ws,
                    version: 1
               };
               console.log(`User ${tokenData.id} has authenticated and is now connected.`);

               var presenceData = helpers.PullPlayerData(tokenData.id);
               presenceData.presence.status = "online";
               if(presenceData.econ.previous_daily_redeemed < (Date.now() - 86400000)) {
                    // Daily login rewards.
                    presenceData.econ.currency += 100;
                    presenceData.econ.previous_daily_redeemed = Date.now();
               }
               helpers.PushPlayerData(tokenData.id, presenceData);
               ws.send("AUTHORIZED");

          } else if (typeof tokenData !== 'undefined') {
               const split = data.split(' ');
               switch(split[0]) {
                    // handle client input
                    case "MM_CMD":
                         var RoomData = await RoomsAPI.GetRoomData(split[2]);
                         if(typeof RoomData == 'undefined') return;
                         switch (split[1]) {
                              case "LEAVE":
                                   if(location.JoinCode !== null) {
                                        var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                        await previousInstance.RemovePlayer(tokenData.id);
                                        await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                        console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                        ws.send("CVR_CMD SIGN-OUT");
                                   } else {
                                        ws.send("EXCEPT You cannot leave an instance, you are not in one.");
                                   }
                                   return;
                              case "CREATE-PRIVATE-INSTANCE":
                                   var PlayerPermissions = Object.keys(RoomData.metadata.permissions).includes(tokenData.id) ? RoomData.metadata.permissions[tokenData.id] : "everyone";
                                   var PermissionTable = RoomData.metadata.permissionTable[PlayerPermissions];

                                   if(!PermissionTable.join) return ws.send("EXCEPT You do not have permission to join that room.");

                                   var localInstance = await MatchmakingAPI.CreateInstance(split[2], MatchmakingModes.Private, 300, false, RoomData.metadata.subrooms[0].maxPlayers);
                                   
                                   localInstance.AddPlayer(tokenData.id);

                                   await MatchmakingAPI.SetInstance(split[2], localInstance.InstanceId, localInstance);

                                   if(location.JoinCode !== null) {
                                        var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                        await previousInstance.RemovePlayer(tokenData.id);
                                        await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                        console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                   }

                                   ws.send(`PUN_CMD CREATE-OR-JOIN-ROOM ${localInstance.JoinCode} ${RoomData.metadata.subrooms[0].maxPlayers}`);

                                   location.RoomId = split[2];
                                   location.JoinCode = localInstance.JoinCode;
                                   console.log(`Player ${tokenData.id} entered room with join code ${localInstance.JoinCode}.`);
                                   return;
                              case "CREATE-PUBLIC-INSTANCE":
                                   var PlayerPermissions = Object.keys(RoomData.metadata.permissions).includes(tokenData.id) ? RoomData.metadata.permissions[tokenData.id] : "everyone";
                                   var PermissionTable = RoomData.metadata.permissionTable[PlayerPermissions];

                                   if(!PermissionTable.join) return ws.send("EXCEPT You do not have permission to join that room.");
                                   if(RoomData.metadata.subrooms[0].matchmakingMode !== MatchmakingModes.Public) return ws.send("EXCEPT Room does not allow public instances.");

                                   var localInstance = await MatchmakingAPI.CreateInstance(split[2], MatchmakingModes.Public, 300, false, RoomData.metadata.subrooms[0].maxPlayers);
                                   
                                   localInstance.AddPlayer(tokenData.id);

                                   await MatchmakingAPI.SetInstance(split[2], localInstance.InstanceId, localInstance);

                                   if(location.JoinCode !== null) {
                                        var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                        await previousInstance.RemovePlayer(tokenData.id);
                                        await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                        console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                   }

                                   ws.send(`PUN_CMD CREATE-OR-JOIN-ROOM ${localInstance.JoinCode} ${RoomData.metadata.subrooms[0].maxPlayers}`);

                                   location.RoomId = split[2];
                                   location.JoinCode = localInstance.JoinCode;
                                   console.log(`Player ${tokenData.id} entered room with join code ${localInstance.JoinCode}.`);
                                   return;
                              case "JOIN-PUBLIC-INSTANCE":
                                   var PlayerPermissions = Object.keys(RoomData.metadata.permissions).includes(tokenData.id) ? RoomData.metadata.permissions[tokenData.id] : "everyone";
                                   var PermissionTable = RoomData.metadata.permissionTable[PlayerPermissions];

                                   if(!PermissionTable.join) return ws.send("EXCEPT You do not have permission to join that room.");

                                   var instances = await MatchmakingAPI.GetInstances(split[2]);

                                   instances = instances.filter(item => item.MatchmakingMode == MatchmakingModes.Public && item.Players + 1 < item.MaxPlayers);
                                   if(instances.length < 1) {
                                        // Normal instance creation
                                        var localInstance = await MatchmakingAPI.CreateInstance(split[2], MatchmakingModes.Public, 300, false, RoomData.metadata.subrooms[0].maxPlayers);
                                   
                                        localInstance.AddPlayer(tokenData.id);

                                        await MatchmakingAPI.SetInstance(split[2], localInstance.InstanceId, localInstance);

                                        if(location.JoinCode !== null) {
                                             var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                             await previousInstance.RemovePlayer(tokenData.id);
                                             await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                             console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                        }

                                        ws.send(`PUN_CMD CREATE-OR-JOIN-ROOM ${localInstance.JoinCode} ${RoomData.metadata.subrooms[0].maxPlayers}`);

                                        location.RoomId = split[2];
                                        location.JoinCode = localInstance.JoinCode;
                                        console.log(`Player ${tokenData.id} entered room with join code ${localInstance.JoinCode}.`);
                                        return;
                                   }
                                   
                                   instances = instances.sort((a, b) => (a.Players.length > b.Players.length) ? 1 : -1);

                                   if(location.JoinCode !== null) {
                                        var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                        await previousInstance.RemovePlayer(tokenData.id);
                                        await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                        console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                   }

                                   var localInstance = instances[0];

                                   localInstance.AddPlayer(tokenData.id);
                                   MatchmakingAPI.SetInstance(localInstance.RoomId, localInstance.InstanceId, localInstance);

                                   ws.send(`PUN_CMD CREATE-OR-JOIN-ROOM ${localInstance.JoinCode} ${localInstance.MaxPlayers}`);
                                   
                                   location.RoomId = localInstance.RoomId;
                                   location.JoinCode = localInstance.JoinCode;
                                   
                                   console.log(`Player ${tokenData.id} joined the largest public instance, with join code ${localInstance.JoinCode}`);
                                   return;
                              case "JOIN-SPECIFIC-INSTANCE":

                                   var PlayerPermissions = Object.keys(RoomData.metadata.permissions).includes(tokenData.id) ? RoomData.metadata.permissions[tokenData.id] : "everyone";
                                   var PermissionTable = RoomData.metadata.permissionTable[PlayerPermissions];

                                   if(!PermissionTable.join) return ws.send("EXCEPT You do not have permission to join that room.");
                                   
                                   var localInstance = await MatchmakingAPI.GetInstanceById(split[2], split[3]);
                                   if(typeof localInstance == 'undefined') return ws.send("EXCEPT Instance does not exist.");
                                   
                                   if(localInstance.MatchmakingMode == MatchmakingModes.Private || localInstance.MatchmakingMode == MatchmakingModes.Locked) return ws.send("EXCEPT Instance is not joinable.");

                                   if(localInstance.Players + 1 > localInstance.MaxPlayers) return ws.send("EXCEPT Instance is full.");
                                   
                                   if(location.JoinCode !== null) {
                                        var previousInstance = await MatchmakingAPI.GetInstanceByJoinCode(location.RoomId, location.JoinCode);
                                        await previousInstance.RemovePlayer(tokenData.id);
                                        await MatchmakingAPI.SetInstance(previousInstance.RoomId, previousInstance.InstanceId, previousInstance);
                                        console.log(`Player ${tokenData.id} left room with join code ${previousInstance.JoinCode}.`);
                                   }

                                   localInstance.AddPlayer(tokenData.id);
                                   MatchmakingAPI.SetInstance(localInstance.RoomId, localInstance.InstanceId, localInstance);
                                   
                                   ws.send(`PUN_CMD CREATE-OR-JOIN-ROOM ${localInstance.JoinCode} ${localInstance.MaxPlayers}`);
                                   
                                   location.RoomId = localInstance.RoomId;
                                   location.JoinCode = localInstance.JoinCode;

                                   console.log(`Player ${tokenData.id} joined a specific instance with join code ${localInstance.JoinCode}`);
                                   return;
                              case "LIST-PUBLIC-INSTANCES":
                                   var instances = await MatchmakingAPI.GetInstances(split[2]);
                                   instances = instances.filter(item => item.MatchmakingMode == MatchmakingModes.Public);
                                   
                                   ws.send(`PUBLIC-INSTANCE-LIST ${JSON.stringify(instances)}`);
                                   return;
                         }
                         return;
                    case "LOG":
                         var split_but_cooler = split.splice(0);
                         console.log(split_but_cooler.join(' '));
                         return;
                    case "PUT_ANALYTIC_VAL":
                         ws.send("ASSERT Feature not implemented.");
                         return;
                    case "BROADCAST_STRING":
                         if(!tokenData.developer) return;

                         split = split.splice(0);
                         broadcastStringToAllClients(split.join(' '));
                         return;
                    case "SEND_STRING":
                         if(!tokenData.developer) return;

                         const user = split[1];
                         split = split.splice(0, 2);

                         sendStringToClient(user, split.join(' '));
                         return;
               }
          }
     });

     ws.on('close', async (data) => {
          if(!ignore_connection_closed && typeof tokenData !== 'undefined') {
               var data = helpers.PullPlayerData(tokenData.id);
               data.presence.status = "offline";
               helpers.PushPlayerData(tokenData.id, data);
               delete ws_connected_clients[tokenData.id];
               console.log(`User ${tokenData.id} disconnected.`);
          } else if (typeof tokenData !== 'undefined') {
               // Handle leaving room in session
          }
     });

     ws.send();
})
wss_v1.once('listening',()=>{
     console.log("WebSockets v1 online & listening.");
});


const WebSocketServerV2 = new WebSocket.Server({server: server, path: '/ws/v2', 'skipUTF8Validation': true}, () => {
     
});
WebSocketServerV2.once('listening', () => {
     console.log("WebSockets v2 online & listening.");
});
WebSocketServerV2.on('connection', (stream) => {
     var ConnectedUserData = {
          uid: null,
          username: "",
          nickname: "",
          isAuthenticated: false,
          tags: [],
          isDeveloper: false,
          isCreativeToolsBetaProgramMember: false
     };

     stream.on('message', (data, isBinary) => {
          try {
               var ParsedContent = JSON.parse(data);
          } catch {
               var send = WebSocketV2_MessageTemplate;
               send.code = "throw_exception";
               send.data = {
                    text: "json_parse_failed"
               };

               return stream.send(send);
          }

          if(typeof ParsedContent.code !== 'string' || typeof send.data !== 'object') return;

          // begin parsing data

          switch(data.code) {
               case "authenticate":
                    if(ConnectedUserData.isAuthenticated) return;
                    
                    if(typeof ParsedContent.data.token !== 'string') {
                         var send = WebSocketV2_MessageTemplate;
                         send.code = "authentication_failed";
                         send.data = {
                              reason: "no_token"
                         };

                         return stream.close(4003, send);
                    }

                    const {success, tokenData, playerData, reason} = middleware.authenticateToken_internal(ParsedContent.data.token);

                    if(!success) {
                         var send = WebSocketV2_MessageTemplate;
                         send.code = "authentication_failed";
                         send.data = {
                              reason: reason
                         };

                         return stream.close(4001, send);
                    }

                    if(Object.keys(ws_connected_clients).includes(tokenData.id)) {
                         var send = WebSocketV2_MessageTemplate;
                         send.code = "connection_declined";
                         send.data = {
                              reason: "duplicate_connection"
                         }

                         return stream.close(4002, send);
                    }

                    // all clear to clean up and proceed

                    ConnectedUserData.uid = tokenData.id;
                    ConnectedUserData.nickname = playerData.public.nickname;
                    ConnectedUserData.isAuthenticated = true;
                    ConnectedUserData.username = tokenData.username;
                    ConnectedUserData.isCreativeToolsBetaProgramMember = playerData.private.availableTags.includes("Creative Tools Beta Program Member");
                    ConnectedUserData.isDeveloper = tokenData.developer;
                    ConnectedUserData.tags = playerData.private.availableTags;

                    var final_send = WebSocketV2_MessageTemplate;
                    final_send.code = "show_screen_message";
                    final_send.data = {
                         message: tokenData.id != "2" ? `Welcome back to Compensation VR.\nYou have ${playerData.notifications.length} unread notifications.` : `welcome back dumbfuck\nread your notifications you've got 9999.`
                    };

                    ws_connected_clients[tokenData.id] = {
                         socket: stream,
                         version: 2
                    };

                    return stream.send(final_send);
               case "dev_force_emit_string":
                    // This command requires you to be signed in.
                    if(!ConnectedUserData.isAuthenticated) return;

                    // This command requires you to be a Developer.
                    if(!ConnectedUserData.isDeveloper) return;

                    if(typeof ParsedContent.data == 'undefined') return;

                    broadcastStringToAllClients(ParsedContent.data);
                    return;
               case "dev_force_send_string":
                    // This command requires you to be signed in.
                    if(!ConnectedUserData.isAuthenticated) return;

                    // This command requires you to be a Developer.
                    if(!ConnectedUserData.isDeveloper) return;

                    if(typeof ParsedContent.data.id == 'undefined') return;
                    if(typeof ParsedContent.data.data == 'undefined') return;

                    sendStringToClient(ParsedContent.data.id, ParsedContent.data.data);
                    return;
          }
     });
     stream.on('close', (code, reason) => {
          if(!ConnectedUserData.isAuthenticated) return;
          if(!Object.keys(ws_connected_clients).includes(ConnectedUserData.uid)) return;

          delete ws_connected_clients[ConnectedUserData.uid];
     });
     stream.on('error', (err) => {
          helpers.auditLog(`Error in WebSocket. UID ${ConnectedUserData.uid} @${ConnectedUserData.username} err:\n\`\`\`${err}\`\`\``);
     });
});


function sendStringToClient(id, data) {
     if(!Object.keys(ws_connected_clients).includes(id)) return;

     const client = ws_connected_clients[id];

     client.socket.send(data);
}

function broadcastStringToAllClients(data) {
     for (let index = 0; index < Object.keys(ws_connected_clients).length; index++) {
          const element = ws_connected_clients[Object.keys(ws_connected_clients)[index]];
          element.socket.send(data);          
     }
}

function getClients() {
     return ws_connected_clients;
}

const { MongoClient } = require('mongodb');
const { MatchmakingModes } = require('./routers/matchmaking');

const uri = `mongodb+srv://CVRAPI%2DDIRECT:${process.env.MONGOOSE_ACCOUNT_PASSWORD}@cluster0.s1qwk.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
     useNewUrlParser: true,
     useUnifiedTopology: true
});

client.connect(async (error, result) => {
     if(error) {
          console.error(`Failed to connect to MongoDB - fatal\n` + error);
          helpers.auditLog(`Failed to connect to MongoDB - fatal\n` + error);
          process.exit(1);
     }

     console.log("MongoDB Connection Established.");

     require('firebase/app').initializeApp(require('./env').firebaseConfig);

     const auth = firebaseAuth.getAuth();

     const firebaseAuthUser = await firebaseAuth.signInWithEmailAndPassword(auth, process.env.FIREBASE_EMAIL, process.env.FIREBASE_API_SECRET);

     if(typeof firebaseAuthUser.user.uid == 'undefined') {
          auditLog('Failed to connect to Firebase - fatal');
          console.error('Failed to connect to Firebase - fatal');
          process.exit(1);
     }

     console.log('Firebase Connection Established.');

     module.exports = {
          sendStringToClient: sendStringToClient,
          mongoClient: client,
          getClients: getClients
     };
     
     process.on('beforeExit', function () {
          helpers.auditLog("Server exit.");
     });
     
     process.on('uncaughtException', function (exception) {
          helpers.auditLog(`Uncaught exception in server.\nException: \`\`\`${exception}\`\`\``);
          console.error(exception);
     });
     
     process.on('SIGINT', function () {
          var Instances = matchmaking.GetInstances("*");

          if(Instances.length > 1) { // Maximum length of ONE because of the default instance for intellisense testing.
               console.log("Server kill command rejected - there are players online with instances active.\nWait for the instances to close or use SIGKILL / SIGTERM");
               return;
          }

          helpers.auditLog("Server killed from command line. Exiting in 0.25 seconds. (250ms)")
     
          setTimeout(() => process.exit(), 250);
     });
});