/**
 * Shubra Qubala Water Canal Project
 * written by Senica Gonzalez (senica@gmail.com)
 * Allebrum, LLC (allebrum.com)
 * 
 * for RISE of AUCegypt.edu
 * 
 * AUC Server
 * You may test by using
 * 	telnet host 3000
 * 
 * This opens a connection and listens for two connections:
 * 1) to an aggregation point in the field on port 3000 which collects data
 * 2) to the webserver to serve up live websocket data
 */

/**
 * User editable values
 */
var dbTimeInterval = 20000; //milliseconds until next entry should be recorded
var mysqlHost = 'localhost';
var mysqlUser = 'root';
var mysqlPass = 'password here';
var mysqlDB = 'water';
var serverKey = 'key here';

/**
 * Includes
 */
var net = require('net');
var exec = require('child_process').exec;

//Storage variables
var sensors = {};
var users = {};
var canals = {};
var server = net.Server;
var pi = net.Socket;

//MySQL connection
var mysql = require('mysql');
var pool  = mysql.createPool({
  host     : mysqlHost,
  user     : mysqlUser,
  password : mysqlPass,
  database : mysqlDB
});


var error = function(s, m){
	s.emit('error', {msg:m});
}

//For testing
var random = function(){
	return Math.floor(Math.random()*100);
}

/**
 * Common Functions
 */
var getWaterFlow = function(d){
	
	console.log(d);
	
	if(typeof d == "undefined")
		return false;
	
	if(typeof canals[d.sensor.canalid] == "undefined")
		return false;
		
	var c = canals[d.sensor.canalid];

	var waterDepthInMillimeters = d.sensor.depth - d.data.water;
	var waterDepth = waterDepthInMillimeters / 1000; //depth in meters
	
	//Get the sensors associated on the same canal
	//'SELECT * FROM sensors WHERE canalid = ? ORDER BY sortorder ASC', [d.canalid]
	
	//http://www.fsl.orst.edu/geowater/FX3/help/8_Hydraulic_Reference/Mannings_n_Tables.htm
	//http://www.fsl.orst.edu/geowater/FX3/help/8_Hydraulic_Reference/Manning_s_Equation.htm
	//http://gilley.tamu.edu/BAEN%20340%20Fluid%20Mechanics/Lectures/Examples%20of%20uniform%20flow.pdf
	// Best site for basic calculations: http://www.geography-fieldwork.org/riverfieldwork/downstream_changes/stage4.htm
	// Wetted Perimeter, in case you had to ask http://en.wikipedia.org/wiki/Wetted_perimeter
	//http://www.trincoll.edu/~jgourley/GEOS%20112%20Stream%20Discharge.htm
	
	// http://www.ehow.com/how_8691136_calculate-channel-slope.html
	// Determine the slope of the water
	// Numbers in this section are just guesimates right now to get 8% slope
	var canalElevation1 = "100"; //Higher of the two (closer to the pump)
	var canalElevation2 = "20"; //Lower of the two, (closer to the field)
	var distanceBetweenElevationPoints = "1000";
	var changeInElevation = canalElevation1 - canalElevation2;
	var slope = changeInElevation / distanceBetweenElevationPoints;
	
	var manningConstant = 1.0; //1.0 for SI and 1.49 for US
	var manningCoefficient = 0.027; //4.a.4 Dredged Canal, Earth bottom, straight, short grass and weeds on the side
	var canalWidth = c.width; //Meters
	var wettedPerimeter = (waterDepth * 2) + canalWidth;
	var crossSectionalArea = canalWidth * waterDepth;
	var hydraulicRadius = crossSectionalArea / wettedPerimeter;
	
	//m3 / sec - The other way to do this is to figure velocity * crossSectionalArea
	var flowRate = (manningConstant / manningCoefficient) * crossSectionalArea * Math.pow(hydraulicRadius, 2/3) * Math.sqrt(slope);
	return flowRate;
}

//This will change based on temperature, humidity, and water flow
var testSMS = function(d){
}

/**
 * Prepopulate some local variables
 */

//sensors
var getSensors = function(){
	pool.getConnection(function(err, connection) {
		if(err){ try{ connection.destroy(); }catch(e){ } error(socket, 'Can\'t get a new database connection'); return false; }
		connection.query( 'SELECT * FROM sensors ORDER BY sortorder ASC', function(err, results) {		
			if(!err)
				for(var i in results){
					sensors[results[i].serialid] = results[i]; 
				}
			else{
				console.log(err);
			}
			connection.end();
		});
	});
}
getSensors(); //init

//canals
var processCanals = function(results, conn){
	var canal = results.shift();
	if(!canal){
		io.sockets.emit('pushCanal', canals);
		conn.end();
		return false;
	}
	conn.query('SELECT * FROM sensors WHERE canalid=? ORDER BY sortorder ASC', canal.id, function(err, r){
		if(!err)
			canal.sensors = r;
		else{
			canal.sensors = [];
			console.log(err);
		}
		canals[canal.id] = canal;
		processCanals(results, conn);
	});
}
var getCanals = function(){
	pool.getConnection(function(err, connection) {
		if(err){ try{ connection.destroy(); }catch(e){ } error(socket, 'Can\'t get a new database connection'); return false; }
		connection.query( 'SELECT *, id AS canalid FROM canals ORDER BY sortorder', function(err, results) {		
			if(!err)
				processCanals(results, connection);
			else{
				console.log(err);
				connection.end();
			}
		});
	});
}
getCanals(); //init

//users
var processUsers = function(results, conn){
	var user = results.shift();
	if(!user){
		io.sockets.emit('addUser', users);
		return false;	
	}
	conn.query('SELECT c.*, c.id AS canalid FROM users_canals uc LEFT JOIN canals c ON c.id = uc.canalid WHERE uc.userid = ?', [user.userid], function(err, canals){
		if(!err)
			user.canals = canals;
		else{
			user.canals = [];
			console.log(err);
		}
		users[user.id] = user;
		processUsers(results, conn);
	});
}
var getUsers = function(){
	pool.getConnection(function(err, connection) {
		if(err){ try{ connection.destroy(); }catch(e){ } error(socket, 'Can\'t get a new database connection'); return false; }
		connection.query( 'SELECT *, id AS userid FROM users', function(err, results) {		
			if(!err){
				processUsers(results, connection);
			}else{
				connection.end();
			}
		});
	});
}
getUsers(); //init

/**
 * Server connection for websockets and live data
 */
var io = require('socket.io').listen(3001);

io.sockets.on('connection', function (socket) {
  socket.emit('welcome', "Welcome to the Shubra Qubala project by allebrum.com.");
 	
 	socket.emit('pushCanal', canals);
 	socket.emit('addUser', users);
	
	socket.on("canalDepth", function(o){
		pool.getConnection(function(err, connection) {
			if(err){
				try{ connection.destroy(); }catch(e){ }
				error(socket, 'Can\'t get a new database connection');
				return false;
			}
			connection.query( 'UPDATE sensors SET depth = ? WHERE serialid = ?', [o.depth, o.sensor], function(err, results) {		
				if(!err){
					sensors[o.sensor].depth = o.depth; //Update local data for users connecting
					io.sockets.emit('canalDepth', o); //Notify all listeners
					getCanals(); //refresh data
				}else{
					console.log(err);
				}
				connection.end();
			});
		});
	});
	
	socket.on("canalWidth", function(o){
		pool.getConnection(function(err, connection) {
			if(err){
				try{ connection.destroy(); }catch(e){ }
				error(socket, 'Can\'t get a new database connection');
				return false;
			}
			connection.query( 'UPDATE canals SET width= ? WHERE id = ?', [o.width, o.canal], function(err, results) {		
				if(!err){
					io.sockets.emit('canalWidth', o); //Notify all listeners
					getCanals(); //refresh data
				}else{
					console.log(err);
				}
				connection.end();
			});
		});
	});
	
	socket.on("canalChange", function(o){
		//Change canal that sensor is attached to
		pool.getConnection(function(err, connection) {
			if(err){
				try{ connection.destroy(); }catch(e){ }
				error(socket, 'Can\'t get a new database connection');
				return false;
			}
			connection.query( 'INSERT INTO sensors (serialid, canalid, sortorder) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE canalid=?, sortorder=?', [o.sensor, o.canal, o.sortorder, o.canal, o.sortorder], function(err, results) {		
				if(!err){
					sensors[o.sensor].canalid = o.canal; //Change local memory as that is what a page will load until the server restarts
					sensors[o.sensor].sortorder = o.sortorder;
					getCanals(); //refresh data
				}else{
					console.log(err);
				}
				connection.end();
			});
		});
	});

	/**
	 * Commands that can be sent from the browser console to control the server
	 */
	socket.on('cmd', function(cmd){
		if(cmd == "getCanals")
			socket.emit('echo', canals);
		else if(cmd == "getUsers")
			socket.emit('echo', users);
		else if(cmd == "address")
			socket.emit('echo', server.address());
		else if(cmd == "getConnections"){
			server.getConnections(function(err, count){
				if(err)
					socket.emit('echo', err);
				else
					socket.emit('echo', count);
			});
		}else if(cmd == "pi")
			socket.emit('echo', pi.remoteAddress+':'+pi.remotePort);
		else if(cmd == "piReboot"){
			socket.emit('echo', 'Rebooting pi...');
			pi.write(JSON.stringify({cmd:'reboot'}));
		}else if(cmd == "piShutdown"){
			socket.emit('echo', 'Shutting down pi...');
			pi.write(JSON.stringify({cmd:'shutdown'}));
		}else{
			socket.emit('echo', "Usage: socket.emit('cmd', [options]); Options can be: getCanals | getUsers | pause | resume | status");
		}
	});
  
  socket.on('db', function(data, reply){
  	pool.getConnection(function(err, connection) {
		if(err){
			try{ connection.destroy(); }catch(e){ reply('fail'); return false; }
			reply('fail');
			return false;
		}
		
		//Record canal on local database
		if(data.type == "addCanal"){
			connection.query( 'INSERT INTO canals (title) VALUES (?)', [data.title], function(err, result) {		
				if(!err){
					reply('ok');
					data.canalid = result.insertId;
					data.sensors = [];
					canals[data.canalid] = data;
					io.sockets.emit('pushCanal', data);
					getCanals(); //refresh data
				}else
					reply('fail');
				connection.end();
			});
		}
	});
  });
  
	//Get Canals
	socket.on('getCanals', function(data, reply){
		reply(canals); //send local variable
	});
  
	socket.on('addUser', function(data, reply){
		pool.getConnection(function(err, connection) {
			if(err){ try{ connection.destroy(); }catch(e){ reply('fail'); return false; } reply('fail'); return false; }
			data.ucell = data.ucell.replace(/[^0-9.]/g, "")
			connection.query( 'INSERT INTO users (uname, ucell) VALUE (?, ?)', [data.uname, data.ucell], function(err, result) {		
				if(!err){
					data.userid = result.insertId;
					for(var i in data.canals){
						connection.query( 'INSERT INTO users_canals (canalid, userid) VALUE (?, ?)', [data.canals[i], data.userid] );
					}
					connection.query( 'SELECT * FROM canals WHERE id IN(?)', [data.canals], function(err, results){
						if(!err){
							data.canals = results;
						}else
							data.canals = {};
						users[data.userid] = data; //Assign to local variable
						reply(data);
						getUsers(); //refresh data
						connection.end();
					});
				}
				else{
					reply('fail');
					connection.end();
				}				
			});
		});
	});  

});

/**
 * Server connection for field Aggregation Point
 */
server = net.createServer(function(c) {
	
	//Time between database entries
	var timeTracker = {};
	
	c.setEncoding('utf8');
	//Do we want to keep track of connections here and log them to the database?
	c.on('end', function(){});
	c.write('Welcome to the Shubra Quabala Project by Allebrum.\r\nNothing to see here.\r\nThis site collects the sensor data from the field.\r\n#####################################\r\n');
	c.on('data', function(data){
		
		try{
			var d=JSON.parse(data.trim());
	    }catch(e){
	    	c.write("Go away! You are not a valid aggregation point.");
			c.destroy();
			return false;
	    }
	    //Each "packet" from the aggregation point should have this key attached
		if(!("key" in d) || d["key"] != serverKey){
			c.write("Go away! You are not a valid aggregation point.");
			c.destroy();
			return false;
		}
		
		//This is just a message
		if(typeof d != "object" || typeof d.serial == "undefined")
			return;
			
		console.log(typeof d);
		
		pi = c; //Assign a variable we can talk to
		
		if(typeof sensors[d.serial] != "undefined")
			d.sensor = sensors[d.serial];
		else{
			d.sensor = {};
			d.sensor.sortorder = 0;
			d.sensor.depth = 0;
			d.sensor.canalid = 0;
		}
		
		//console.log("flow rate" +getWaterFlow(d));
		var flow = getWaterFlow(d);
		
		//Add reading data to the database - currently the only data we are processing
		//If id is not set (it's a new sensor or program just started) or it is set and the correct amount of time has elapsed...
		if(!(d.serial in timeTracker) || Date.now() > timeTracker[d.serial] + dbTimeInterval){
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
				connection.query( 'INSERT INTO readings (netid, serialid, water, sound, temp, humidity, entrydate, waterflow) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [d.netid, d.serial, d.data.water, d.data.sound, d.data.temp, d.data.humidity, new Date, flow ], function(err, result) {		
					if(!err){
						timeTracker[d.serial] = Date.now();
					}else
						console.log(err);
					connection.end();
				});
			});	
		}
		
		io.sockets.emit('reading', d);
	});
});
server.listen(3000, function(){}); //function called when server is bound



//Testing
  //sensors['ABECKALS'] = {canalid:2, sortorder:2};
  //setInterval(function(){
  //	socket.emit('reading', {serial:'ABECKALS', data:{water:random(), sound:random(), temp:random(), humidity:random()}, name:"Untitled", sensor:{canalid:2, sortorder:2}});
  //}, 3000);
  //Testing
  //sensors['ABECKALS'] = {canalid:2, sortorder:2};
var net = require('net');
var client = net.connect({host:"controlnv.com", port: 3000},
    function() {});
  setInterval(function(){
  	var s = {key:'key here', netid:'2452', serial:'ABECKALS', data:{water:random(), sound:random(), temp:random(), humidity:random()}};
  	client.write(JSON.stringify(s));
  }, 3000);
