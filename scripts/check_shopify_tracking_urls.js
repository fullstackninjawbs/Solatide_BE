const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const AnalyticsEvent = mongoose.model('AnalyticsEvent', new mongoose.Schema({}, { strict: false }));
  
  // Find all events with _t in path or page
  const events = await AnalyticsEvent.find({
    $or: [
      { path: { $regex: '_t' } },
      { page: { $regex: '_t' } }
    ]
  }).sort({ timestamp: -1 }).limit(100).lean();

  console.log('Found events with _t:', events.length);
  events.forEach(e => {
    console.log(JSON.stringify({
      timestamp: e.timestamp,
      path: e.path,
      page: e.page,
      referrer: e.referrer,
      country: e.country,
      userAgent: e.userAgent
    }, null, 2));
  });

  // Also check for legacy Shopify routes like /policies/
  const policyEvents = await AnalyticsEvent.find({
    $or: [
      { path: { $regex: 'policies' } },
      { page: { $regex: 'policies' } }
    ]
  }).sort({ timestamp: -1 }).limit(50).lean();
  console.log('Found events with policies:', policyEvents.length);
  policyEvents.forEach(e => {
    console.log(e.timestamp, e.path || e.page);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
