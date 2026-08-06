const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const schema = new mongoose.Schema({
  sessionId: String,
  eventType: String,
  timestamp: Date,
  country: String,
  region: String,
  city: String,
  page: String,
  path: String
});

const AnalyticsEvent = mongoose.models.AnalyticsEvent || mongoose.model('AnalyticsEvent', schema);

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/solatide';
  await mongoose.connect(uri);
  const liveWindow = new Date(Date.now() - 5 * 60 * 1000);
  const events = await AnalyticsEvent.find({ timestamp: { $gte: liveWindow } }).sort({ timestamp: -1 });

  console.log(`Found ${events.length} events in the last 5 minutes:`);
  events.forEach(e => {
    console.log(`- Time: ${e.timestamp.toISOString()}, Session: ${e.sessionId.substring(0, 8)}..., Type: ${e.eventType}, Page: ${e.page}, Country: ${e.country}`);
  });

  await mongoose.disconnect();
}

main().catch(console.error);
