/**
 * Allebrum, LLC (allebrum.com)
 * Senica Gonzalez senica@gmail.com
 * 
 * Aggregation point for sensors in Shubra Qubala.
 * 
 * - Creates a client connection to server on port 3000 and sends it data it collects from the sensors
 * - Records data to the database as it receives it from the sensors at dbTimeInterval
 * - Processes packets from XBEE
 * 
 * TODO: Need to decide if we are sending SMS from here or from server, will currently do from server.
 *   	 You can send it from here as demonstrated in sms.js.bak in this same directory.
 * TODO: Need to open up ssh to this server via 3G connection, then we can handle most everything from here.
 * 		 I don't want to do it here in case we need to change something, it will require a trip to Shubra
 * TODO: Handle error logging
 */

/**
 * User editable values
 */
var dbTimeInterval = 1200000; //milliseconds until next entry should be recorded - 20 minutes
var mysqlHost = 'localhost';
var mysqlUser = 'root';
var mysqlPass = 'password here';
var mysqlDB = 'water';
var serverHost = 'host here';
var serverPort = 3000;
var packetKey = 'key here';

/**
 * Includes
 */
var exec = require('child_process').exec;
var sp = require("serialport");
var serialport = sp.SerialPort;

//XBEE Setup
var xbeePort = '/dev/tty-xbee'; //Custom Port, back port on the right side
var xbee = new serialport(xbeePort, {
	baudRate: 9600,
	dataBits: 8,
	parity: 'none',
	stopBits: 1,
	flowControl: false
});

//Thermostat Setup
var thermostatPort = '/dev/tty-thermostat'; //Custom Port, front port on the right side
var thermostat = new serialport(thermostatPort, {
	baudRate: 9600,
	dataBits: 8,
	parity: 'none',
	stopBits: 1,
	flowControl: false,
	parser: sp.parsers.readline("\n")
});

//Thermostat event handlers
var temperature;
var humidity;
thermostat.on('data', function (data) {
	try{
		var th = JSON.parse(data);
	}catch(e){
		return false;
	}
	if(typeof th != "undefined"){
		temperature = th.temp;
		humidity = th.humidity;
	}
});

var buf = [];
var bufLen = 0;
var bufUsed = 0;

//Process XBEE packet
var processPacket = function(buf){
	if(buf[0] != 0x7E) //Not the start of a valid packet from XBEE
		return false;
		
	var packet = { key:packetKey };
	
	switch(buf[3]){
		case 0x90:
			packet.netid = buf.slice(12, 14).toString('hex');
			packet.serial = buf.slice(4, 12).toString('hex');
			try{
				packet.data = JSON.parse(buf.slice(15, buf.length - 1).toString());
			}catch(e){ return false; }	
			break;
		default:
			return false;
			break;
	}
	
	//Verify checksum		
	var checksumTotal = 0;
	for(var i=3; i<buf.length-1; i++){
		checksumTotal += buf[i];
	}
	checksumTotal = checksumTotal & 0xFF; //only lower 8 bits
	var checksum = 0xFF - checksumTotal;
	if(buf[buf.length-1] != checksum) //console.log(checksum.toString(16));
		return false;
		
	processData(packet);
		
}

var receivingPacket = false;
var pBuff;

//XBEE event handlers
xbee.on('data', function (data) {
	if(receivingPacket == false && data[0] == 0x7e){
		receivingPacket = true;
		buf = [];
		bufLen = 0;
		bufUsed = 0;
		if(data[3] == 0x90){ //Received Transmission
			bufLen = data[2] + 4; //Start byte, start length byte, end length byte, checksum byte
		}
	}
	
	if(receivingPacket == true && bufUsed >= bufLen){
		pBuf = new Buffer(bufUsed); //In case we get another packet right behind it
		var pos = 0;
		for(var i=0, len=buf.length; i<len; i++){
			try{
				buf[i].copy(pBuf, pos);
			}catch(e){ //Sometimes we get a corrupt packet, discard and wait for the next one
				receivingPacket = false;
				return false;
			}				
			pos += buf[i].length;
		}
		receivingPacket = false;
		processPacket(pBuf);
	}else if(receivingPacket == true){
		buf.push(data);
		bufUsed += data.length;
	}
});

//Should record errors to database for inspection, but no tunneling in right now so pointless
xbee.on('close', function (err) {
	console.log('port closed');
});
 
xbee.on('error', function (err) {
	console.error("error", err);
});
 
xbee.on('open', function () {
	console.log('port opened...');
});



//MySQL connection
var mysql = require('mysql');
var pool  = mysql.createPool({
  host     : mysqlHost,
  user     : mysqlUser,
  password : mysqlPass,
  database : mysqlDB
});

//Client connection to the server
var net = require('net');
var clientConnected = false;
var client = new net.Socket;
client.on('data', function(data) {
	try{
		var d = JSON.parse(data.trim());
	}catch(e){
		//console.log(data.toString());
	}
	
	if(typeof d != "undefined" && typeof d.cmd != "undefined"){
		if(d.cmd == "reboot"){
			console.log("Server should be restarting...");
			var restart = exec('sudo shutdown -r now', function (error, stdout, stderr) {
				if(error){
					console.log(error);
				}else{
					console.log(stdout);
					console.log(stderr);
				}
			});
		}
		
		if(d.cmd == "shutdown"){
			console.log("Server should be shutting down...");
			var restart = exec('sudo shutdown -h now', function (error, stdout, stderr) {
				if(error){
					console.log(error);
				}else{
					console.log(stdout);
					console.log(stderr);
				}
			});
		}
	}
});
client.on('end', function() { 
  console.log('client disconnected');
  clientConnected = false;
});
client.on('error', function(e){
	console.log(e);
	clientConnected = false;
});
client.on('connect', function(){
	clientConnected = true;
  	console.log('Connected to Server');
  	var packet = { key:packetKey };
  	packet.data = "\r\nAggregation Point connected to you!\r\n";
  	client.write(JSON.stringify(packet)); 
});
//Check every 10 seconds to make sure we are still connected
setInterval(function(){
	if(clientConnected == false){
		client.connect({host:serverHost, port:serverPort});
	}
}, 10000);

//Time between database entries
var timeTracker = {};

var processData = function(packet){
	//console.log(packet);
	//If id is not set (it's a new sensor or program just started) or it is set and the correct amount of time has elapsed...
	if(!(packet.serial in timeTracker) || Date.now() > timeTracker[packet.serial] + dbTimeInterval){
		pool.getConnection(function(err, connection) {
			if(err){
				try{
					connection.destroy();
				}catch(e){
					return false;
				}
				return false;
			}
			
			//Record data on local database
			connection.query( 'INSERT INTO readings (netid, serialid, water, sound, temp, humidity, entrydate) VALUES (?, ?, ?, ?, ?, ?, ?)', [packet.netid, packet.serial, packet.data.water, packet.data.sound, temperature, humidity, new Date ], function(err, result) {		
				if(!err){
					timeTracker[packet.serial] = Date.now();
					//console.log(packet.serial + ' - ' + packet.data.water);
				}
				connection.end();
			});
		});	
	}
	
	//Reassign to aggregation point reading
	packet.data.temp = temperature;
	packet.data.humidity = humidity;
	
	client.write(JSON.stringify(packet));
}
