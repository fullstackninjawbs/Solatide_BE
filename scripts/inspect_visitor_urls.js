const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function check() {
  const uri = process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('=== Checking /_t/ or v3 in analyticsevents ===');
  const tEvents = await db.collection('analyticsevents').find({
    $or: [
      { path: { $regex: '_t' } },
      { page: { $regex: '_t' } },
      { path: { $regex: 'v3' } },
      { page: { $regex: 'v3' } }
    ]
  }).toArray();

  console.log('Total matches found:', tEvents.length);
  for (const e of tEvents) {
    console.log({
      time: e.timestamp,
      sessionId: e.sessionId,
      eventType: e.eventType,
      path: e.path,
      page: e.page,
      country: e.country,
      city: e.city
    });
  }

  console.log('\n=== Checking ALL distinct paths containing _ or /c/ or /t/ ===');
  const unusualEvents = await db.collection('analyticsevents').find({
    $or: [
      { path: { $regex: '/_t/' } },
      { page: { $regex: '/_t/' } },
      { path: { $regex: '^/_' } },
      { page: { $regex: '^/_' } },
      { path: { $regex: '/c/' } },
      { page: { $regex: '/c/' } }
    ]
  }).toArray();
  console.log('Unusual events count:', unusualEvents.length);
  for (const e of unusualEvents) {
    console.log({
      time: e.timestamp,
      path: e.path,
      page: e.page,
      country: e.country
    });
  }

  // Also check if there are other collections in MongoDB (e.g., visitors, logs, sessions, analytics)
  const collections = await db.listCollections().toArray();
  console.log('\nAll Collections:', collections.map(c => c.name));

  for (const col of collections) {
    if (col.name.includes('log') || col.name.includes('session') || col.name.includes('visit') || col.name.includes('analytic')) {
      const colCount = await db.collection(col.name).countDocuments();
      console.log(`Collection ${col.name} has ${colCount} docs`);
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
