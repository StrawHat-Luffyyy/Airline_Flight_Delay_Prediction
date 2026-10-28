// Runs every query of the report draft and prints labelled results.
const out = (label, value) => print(`### ${label}\n${JSON.stringify(value, null, 1)}`);
const fd = db.getSiblingDB('flight_delay');
const demo = db.getSiblingDB('flight_delay_demo');
demo.dropDatabase();

// ---------- CREATE ----------
fd.flights.aggregate([
  { $match: { date: ISODate('2015-12-25'), origin: 'ATL' } },
  { $out: { db: 'flight_delay_demo', coll: 'flights' } },
]);
out('C1 $out sample count', demo.flights.countDocuments());

const src = fd.flights.findOne({ route: 'ORD-LAX', causes: { $type: 'object' } }, { _id: 0 });
out('C2 insertOne', demo.flights.insertOne({ ...src, _id: 'ORD-LAX-UA1665-2015-01-01' }));

const three = fd.flights
  .find({ route: 'JFK-LAX', date: ISODate('2015-12-24') }, { _id: 0 })
  .sort({ schedDepMin: 1 })
  .limit(3)
  .toArray();
out('C3 insertMany', demo.flights.insertMany(three, { ordered: false }));
out('C3 count after', demo.flights.countDocuments());

// ---------- READ ----------
out(
  'R1 find AA March first 3',
  fd.flights
    .find(
      { airline: 'AA', date: { $gte: ISODate('2015-03-01'), $lt: ISODate('2015-04-01') } },
      { _id: 0, date: 1, flightNumber: 1, route: 1, arrDelay: 1 },
    )
    .sort({ date: 1 })
    .limit(3)
    .toArray(),
);
const r1 = fd.flights
  .find({ airline: 'AA', date: { $gte: ISODate('2015-03-01'), $lt: ISODate('2015-04-01') } })
  .explain('executionStats');
out('R1 explain', {
  index: r1.queryPlanner.winningPlan.inputStage?.indexName,
  nReturned: r1.executionStats.nReturned,
  keys: r1.executionStats.totalKeysExamined,
  docs: r1.executionStats.totalDocsExamined,
  ms: r1.executionStats.executionTimeMillis,
});
out('R2 count delayed December', fd.flights.countDocuments({ month: 12, isDelayed: true }));
out(
  'R3 delay rate by airline December',
  fd.flights
    .aggregate([
      { $match: { month: 12, isDelayed: { $ne: null } } },
      { $group: { _id: '$airline', flights: { $sum: 1 }, delayed: { $sum: { $cond: ['$isDelayed', 1, 0] } } } },
      { $project: { flights: 1, delayRate: { $round: [{ $divide: ['$delayed', '$flights'] }, 4] } } },
      { $sort: { delayRate: -1 } },
      { $limit: 5 },
    ])
    .toArray(),
);
out(
  'R4 stats_route worst 3 (>=1000 flights)',
  fd.stats_route
    .find({ flights: { $gte: 1000 } }, { flights: 1, delayRate: 1 })
    .sort({ delayRate: -1 })
    .limit(3)
    .toArray(),
);

// ---------- UPDATE ----------
out(
  'U1 updateMany pipeline delayBand',
  demo.flights.updateMany({}, [
    {
      $set: {
        delayBand: {
          $switch: {
            branches: [
              { case: { $eq: ['$isDelayed', null] }, then: 'no-outcome' },
              { case: { $lt: ['$arrDelay', 15] }, then: 'on-time' },
              { case: { $lt: ['$arrDelay', 60] }, then: '15-59 min late' },
            ],
            default: '60+ min late',
          },
        },
      },
    },
  ]),
);
out(
  'U1 verify',
  demo.flights.aggregate([{ $group: { _id: '$delayBand', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
);

const stream = fd.stream_flights.findOne({ _id: '2015-12-01|AA|1230|SEA|5' });
const key = stream._id;
demo.stream_flights.insertOne(stream);
const deliver = () =>
  demo.stream_flights.updateOne(
    { _id: key },
    {
      $setOnInsert: { runId: stream.runId, pre: stream.pre, outcome: stream.outcome, prediction: stream.prediction },
      $set: { lastWrittenAt: new Date() },
      $inc: { deliveries: 1 },
    },
    { upsert: true },
  );
out('U2 key and deliveries before', { key, deliveries: stream.deliveries, prediction: stream.prediction });
out('U2 redelivery result', deliver());
const after = demo.stream_flights.findOne({ _id: key });
out('U2 after', { deliveries: after.deliveries, prediction: after.prediction, count: demo.stream_flights.countDocuments() });

// ---------- DELETE ----------
out('D1 cancelled before', demo.flights.countDocuments({ cancelled: true }));
out('D1 deleteMany cancelled', demo.flights.deleteMany({ cancelled: true }));
out('D1 remaining', demo.flights.countDocuments());

fd.stats_delay_buckets.aggregate([{ $out: { db: 'flight_delay_demo', coll: 'stats_delay_buckets' } }]);
const current = demo.stats_delay_buckets.findOne().buildId;
demo.stats_delay_buckets.insertOne({ _id: 'stale-key', flights: 1, buildId: 'old-build' });
out('D2 sweep', demo.stats_delay_buckets.deleteMany({ buildId: { $ne: current } }));
out('D2 remaining', demo.stats_delay_buckets.countDocuments());

// ---------- BDA 1: PARTITIONING ----------
out(
  'P1 partitions by split and month',
  fd.flights.aggregate([{ $group: { _id: { split: '$split', month: '$month' }, flights: { $sum: 1 } } }, { $sort: { '_id.month': 1 } }]).toArray(),
);
const p2 = fd.flights.explain('executionStats').count({ isDelayed: true, month: 12 });
const stage = (s) => (s ? [s.stage, ...stage(s.inputStage)] : []);
out('P2 partition pruning explain', {
  plan: stage(p2.queryPlanner.winningPlan),
  index: p2.queryPlanner.winningPlan.inputStage?.indexName,
  keys: p2.executionStats.totalKeysExamined,
  docs: p2.executionStats.totalDocsExamined,
  ms: p2.executionStats.executionTimeMillis,
});
out(
  'P3 top origins',
  fd.flights.aggregate([{ $group: { _id: '$origin', flights: { $sum: 1 } } }, { $sort: { flights: -1 } }, { $limit: 5 }]).toArray(),
);
out(
  'P3 shard-key cardinality',
  fd.flights
    .aggregate(
      [
        { $group: { _id: { origin: '$origin', date: '$date' }, n: { $sum: 1 } } },
        { $group: { _id: null, distinctKeys: { $sum: 1 }, maxPerKey: { $max: '$n' }, avgPerKey: { $avg: '$n' } } },
      ],
      { allowDiskUse: true },
    )
    .toArray(),
);
out('P3 avgObjSize', fd.flights.stats().avgObjSize);

// ---------- BDA 2: BUCKETING ----------
const live = fd.flights
  .aggregate([
    { $match: { isDelayed: { $ne: null } } },
    { $bucket: { groupBy: '$arrDelay', boundaries: [-100000, -15, 0, 15, 30, 60, 120, 180, 100000], default: 'outOfRange', output: { flights: { $sum: 1 } } } },
  ])
  .toArray();
out('B1 $bucket arrDelay', live);
const stored = fd.stats_delay_buckets.find({}, { buildId: 0 }).sort({ _id: 1 }).toArray();
out('B1 equals stats_delay_buckets', JSON.stringify(live) === JSON.stringify(stored));
out(
  'B2 $bucketAuto distance',
  fd.flights
    .aggregate(
      [
        { $match: { isDelayed: { $ne: null } } },
        { $bucketAuto: { groupBy: '$distance', buckets: 5, output: { flights: { $sum: 1 }, delayed: { $sum: { $cond: ['$isDelayed', 1, 0] } } } } },
        { $project: { _id: 1, flights: 1, delayRate: { $round: [{ $divide: ['$delayed', '$flights'] }, 4] } } },
      ],
      { allowDiskUse: true },
    )
    .toArray(),
);

demo.dropDatabase();
out('cleanup', db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name));
