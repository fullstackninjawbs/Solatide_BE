const mongoose = require('mongoose');

const uri = 'mongodb+srv://solatidebiosciences_db_user:seUUzWP9nq5zLygO@cluster-solatide.hjunoiw.mongodb.net/?appName=Cluster-Solatide';

async function run() {
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
  
  const pageColl = mongoose.connection.collection('pages');
  
  // 1. Update bpc-157-vs-tb-500 metaDescription
  const r1 = await pageColl.updateOne(
    { slug: 'bpc-157-vs-tb-500' },
    { $set: { metaDescription: 'Compare BPC-157 and TB-500 research peptides. Explore mechanisms of action, tissue repair pathways, and laboratory protocols for research use.' } }
  );
  console.log('Updated bpc-157-vs-tb-500:', r1.modifiedCount);

  // 2. Check and update retatrutide-vs-semaglutide-research links in DB
  const page = await pageColl.findOne({ slug: 'retatrutide-vs-semaglutide-research' });
  if (page) {
    let rawStr = JSON.stringify(page.content);
    let updatedStr = rawStr
      .replace(/\/products\/semaglutide-5mg-lyophilised-peptide/g, '/products/semaglutide-5mg')
      .replace(/\/products\/semaglutide-10mg-lyophilised-peptide/g, '/products/semaglutide-10mg')
      .replace(/\/products\/retatrutide-5mg-lyophilised-peptide/g, '/products/retatrutide-5mg')
      .replace(/\/products\/retatrutide-10mg-lyophilised-peptide/g, '/products/retatrutide-10mg')
      .replace(/href=\\"\/privacy-policy\\"/g, 'href=\\"/pages/privacy-policy\\"');
      
    if (rawStr !== updatedStr) {
      await pageColl.updateOne(
        { _id: page._id },
        { $set: { content: JSON.parse(updatedStr) } }
      );
      console.log('Updated retatrutide-vs-semaglutide-research content in DB!');
    } else {
      console.log('No link replacements needed in DB');
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
