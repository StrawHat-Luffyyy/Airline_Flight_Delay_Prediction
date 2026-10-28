// Viva runbook: every MONGOSH block of docs/report/PROJECT_REPORT.md (Sections 6-8), in order.
// Paste block by block at the  flight_delay>  prompt, or pipe the whole file (Appendix B).
// Reads use flight_delay; writes go only to flight_delay_demo, which is dropped at the end.

db.getName()
db.flights.countDocuments()

var demo = db.getSiblingDB('flight_delay_demo')
demo.dropDatabase()

db.flights.aggregate([
  { $match: { date: ISODate('2015-12-25'), origin: 'ATL' } },
  { $out: { db: 'flight_delay_demo', coll: 'flights' } }
])
demo.flights.countDocuments()

var src = db.flights.findOne({ route: 'ORD-LAX', causes: { $type: 'object' } }, { _id: 0 })
demo.flights.insertOne({ ...src, _id: 'ORD-LAX-UA1665-2015-01-01' })
demo.flights.findOne(
  { _id: 'ORD-LAX-UA1665-2015-01-01' },
  { airline: 1, flightNumber: 1, route: 1, date: 1, arrDelay: 1 }
)

var three = db.flights.find(
  { route: 'JFK-LAX', date: ISODate('2015-12-24') }, { _id: 0 }
).sort({ schedDepMin: 1 }).limit(3).toArray()
demo.flights.insertMany(three, { ordered: false })
demo.flights.countDocuments()

db.flights.find(
  { airline: 'AA', date: { $gte: ISODate('2015-03-01'), $lt: ISODate('2015-04-01') } },
  { _id: 0, date: 1, flightNumber: 1, route: 1, arrDelay: 1 }
).sort({ date: 1 }).limit(3)

var e = db.flights.find(
  { airline: 'AA', date: { $gte: ISODate('2015-03-01'), $lt: ISODate('2015-04-01') } }
).explain('executionStats')
;({
  index: e.queryPlanner.winningPlan.inputStage.indexName,
  returned: e.executionStats.nReturned,
  keysExamined: e.executionStats.totalKeysExamined,
  docsExamined: e.executionStats.totalDocsExamined
})

db.flights.countDocuments({ month: 12, isDelayed: true })

db.flights.aggregate([
  { $match: { month: 12, isDelayed: { $ne: null } } },
  { $group: { _id: '$airline', flights: { $sum: 1 },
              delayed: { $sum: { $cond: ['$isDelayed', 1, 0] } } } },
  { $project: { flights: 1,
                delayRate: { $round: [{ $divide: ['$delayed', '$flights'] }, 4] } } },
  { $sort: { delayRate: -1 } },
  { $limit: 5 }
])

db.stats_route.find(
  { flights: { $gte: 1000 } }, { flights: 1, delayRate: 1 }
).sort({ delayRate: -1 }).limit(3)

demo.flights.updateMany({}, [
  { $set: { delayBand: { $switch: {
    branches: [
      { case: { $eq: ['$isDelayed', null] }, then: 'no-outcome' },
      { case: { $lt: ['$arrDelay', 15] }, then: 'on-time' },
      { case: { $lt: ['$arrDelay', 60] }, then: '15-59 min late' }
    ],
    default: '60+ min late'
  } } } }
])
demo.flights.aggregate([
  { $group: { _id: '$delayBand', n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])

var s = db.stream_flights.findOne({ _id: '2015-12-01|AA|1230|SEA|5' })
demo.stream_flights.insertOne(s)
demo.stream_flights.findOne({ _id: s._id }, { deliveries: 1, 'prediction.label': 1 })

demo.stream_flights.updateOne(
  { _id: s._id },
  { $setOnInsert: { runId: s.runId, pre: s.pre, outcome: s.outcome,
                    prediction: s.prediction },
    $set: { lastWrittenAt: new Date() },
    $inc: { deliveries: 1 } },
  { upsert: true }
)
demo.stream_flights.findOne({ _id: s._id }, { deliveries: 1, 'prediction.label': 1 })
demo.stream_flights.countDocuments()

demo.flights.countDocuments({ cancelled: true })
demo.flights.deleteMany({ cancelled: true })
demo.flights.countDocuments()

db.stats_delay_buckets.aggregate([
  { $out: { db: 'flight_delay_demo', coll: 'stats_delay_buckets' } }
])
var current = demo.stats_delay_buckets.findOne().buildId
demo.stats_delay_buckets.insertOne({ _id: 'stale-key', flights: 1, buildId: 'old-build' })
demo.stats_delay_buckets.deleteMany({ buildId: { $ne: current } })
demo.stats_delay_buckets.countDocuments()

db.flights.aggregate([
  { $group: { _id: { split: '$split', month: '$month' }, flights: { $sum: 1 } } },
  { $sort: { '_id.month': 1 } }
])

var p = db.flights.explain('executionStats').count({ isDelayed: true, month: 12 })
;({
  stage: p.queryPlanner.winningPlan.inputStage.stage,
  index: p.queryPlanner.winningPlan.inputStage.indexName,
  keysExamined: p.executionStats.totalKeysExamined,
  docsExamined: p.executionStats.totalDocsExamined
})

db.flights.aggregate([
  { $group: { _id: '$origin', flights: { $sum: 1 } } },
  { $sort: { flights: -1 } },
  { $limit: 5 }
])
db.flights.aggregate([
  { $group: { _id: { origin: '$origin', date: '$date' }, n: { $sum: 1 } } },
  { $group: { _id: null, distinctKeys: { $sum: 1 },
              maxPerKey: { $max: '$n' }, avgPerKey: { $avg: '$n' } } }
], { allowDiskUse: true })
db.flights.stats().avgObjSize

db.flights.aggregate([
  { $match: { isDelayed: { $ne: null } } },
  { $bucket: { groupBy: '$arrDelay',
    boundaries: [-100000, -15, 0, 15, 30, 60, 120, 180, 100000],
    default: 'outOfRange', output: { flights: { $sum: 1 } } } }
])
db.stats_delay_buckets.find({}, { buildId: 0 }).sort({ _id: 1 })

db.flights.aggregate([
  { $match: { isDelayed: { $ne: null } } },
  { $bucketAuto: { groupBy: '$distance', buckets: 5,
    output: { flights: { $sum: 1 },
              delayed: { $sum: { $cond: ['$isDelayed', 1, 0] } } } } },
  { $project: { flights: 1,
                delayRate: { $round: [{ $divide: ['$delayed', '$flights'] }, 4] } } }
], { allowDiskUse: true })

demo.dropDatabase()
show dbs
exit
