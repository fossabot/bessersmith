http = require('http');
url = require('url');

mqtt = require('mqtt');
moment = require('moment');
protobuf = require('protobufjs')

_ = require('lodash');

const parseIsoDatetime = (datetime) => {
    return(moment(datetime, 'YYYY-MM-DDTHH:mm:ss.SSSZZ').toDate());
};

function build_feed() {
    tripIds = _.sortBy(Object.keys(trips));
    tripUpdates = tripIds.map(function(tripId) {
        var trip = trips[tripId];
        var routeId = tripId.split(/_/g)[0];
        var directionId = tripId.split(/_/g)[1];
        var start = tripId.split(/_/g)[2];

        return {
            id: tripId,
            tripUpdate: {
                trip: {
                    routeId: routeId,
                    directionId: Number(directionId)-1,
                    startTime: start.split("T")[1].split("+")[0],
                    startDate: start.split("T")[0].replace(/-/g, ""),
                },
                stopTimeUpdate: _.sortBy(Object.keys(trips[tripId]).map(function (stopId) { 
                    var stoptime = trip[stopId];
                    var delay = stoptime.predicted - stoptime.scheduled;
                    return {
                        stopId: stopId,
                        arrival: { time: stoptime.predicted, delay: delay },
                        departure: { time: stoptime.predicted, delay: delay },
                    };
                }), 'departure.time')
            }
        };
    });

    return {
        header: {
            gtfsRealtimeVersion: "1.0",
            timestamp: Math.floor(new Date().getTime()/1000),
        },
        entity: tripUpdates,
    };
}

const createServer = function () {
trips = {};

mqttConnection = mqtt.connect('mqtt://mqtt.hsl.fi');

mqttConnection.subscribe('mono/#', function() { console.log(arguments); });
mqttConnection.on('message', function(topic, message) {
    var msgdata = JSON.parse(message);
    for (var i = 0; i < (msgdata.predictions && msgdata.predictions.length || 0); i++) {
        var data = msgdata.predictions[i];
        var trip = data.joreLineId+"_"+data.joreLineDirection+"_"+data.journeyStartTime; // XXX variants
        var stop = data.joreStopId;
        if (!trips[trip])
            trips[trip] = {};
        trips[trip][data.joreStopId] = {
            stop: stop,
            scheduled: Math.floor(parseIsoDatetime(data.scheduledDepartureTime).getTime()/1000),
            predicted: Math.floor(parseIsoDatetime(data.predictedDepartureTime).getTime()/1000),
        };
        stoptimes = Object.keys(trips[trip]).map(function (key) { return trips[trip][key]; });
    }
});

httpServer = http.createServer(function(request, response) {
  console.log(request.method+" "+request.url);
  var query = url.parse(request.url, true).query;
  var pathname = url.parse(request.url).pathname;
  var now = new Date();
  if (pathname == "/") {
    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.write('Nothing to see here');
    response.end();
  } else if (pathname == "/gtfs-rt/trip-updates/pbf") {
    payload = build_feed();
    protobuf.load("gtfs-realtime.proto", function(err, root) {
      if (err)
          throw err;
      var FeedMessage = root.lookupType("transit_realtime.FeedMessage");
      var errMsg = FeedMessage.verify(payload);
      if (errMsg)
          throw errMsg;
      var message = FeedMessage.create(payload);
      if (query.debug!=='') {
        response.writeHead(200, {'Content-Type': 'application/x-protobuf'});
        response.write(FeedMessage.encode(message).finish());
      } else {
        response.writeHead(200, {'Content-Type': 'text/plain'});
        response.write(JSON.stringify(FeedMessage.decode(FeedMessage.encode(message).finish()).toJSON()));
      }
      response.end();
    });
  } else if (pathname == "/gtfs-rt/trip-updates/json") {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.write(JSON.stringify(build_feed(trips)));
    response.end();
  } else {
    response.writeHead(404, {'Content-Type': 'text/plain'});
    response.write("Not found: " + request.url);
    response.end();
  }
});
return(httpServer);
};

exports.createServer = createServer;
exports.parseIsoDatetime = parseIsoDatetime;