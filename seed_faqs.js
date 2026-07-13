const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const faqSectionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    questions: [
      {
        question: { type: String, required: true, trim: true },
        answer: { type: String, required: true, trim: true },
        isVisible: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

const FaqSection = mongoose.model('FaqSection', faqSectionSchema, 'faqsections'); // mongoose pluralizes FaqSection to faqsections

const faqData = [
    {
        title: "Research Use & Compliance",
        items: [
            {
                question: "Are these products for human consumption?",
                answer: "<ul class='list-disc pl-5'><li class='text-[#6A6A6A] font-medium'>Bacteriostatic Water:Sterile water with 0.9% benzyl alcohol preservative for peptide reconstitution</li></ul>",
            },
            { question: "Do You Provide Preparation Protocols Or Application Guidance?", answer: "Content for this section will be added here." },
            { question: "What Are My Responsibilities As A Buyer?", answer: "Content for this section will be added here." },
            { question: "Where Can I Learn More About Specific Peptides?", answer: "Content for this section will be added here." }
        ]
    },
    {
        title: "Product Information & Storage",
        items: [
            {
                question: 'What does "lyophilised" mean?',
                answer: "Lyophilisation is a freeze-drying process that removes water from a sample while preserving its molecular structure. We supply peptides as lyophilised powders because it increases stability and structural integrity during transit and storage."
            },
            { question: "What Is Reconstitution?", answer: "Content for this section will be added here." },
            { question: "Why Does The Powder In My Vial Look Different From My Last Order?", answer: "Content for this section will be added here." },
            { question: "Do Vial Images, Cap Colours, Or Packaging Match Exactly What I Receive?", answer: "Content for this section will be added here." },
            { question: "How Should I Store My Research Compounds?", answer: "Content for this section will be added here." },
            { question: "Do You Sell Bacteriostatic Water Or Diluents?", answer: "Content for this section will be added here." }
        ]
    },
    {
        title: "Documentation & Quality",
        items: [
            {
                question: "Are Certificates of Analysis (COAs) available?",
                answer: "Yes. Selected product-level COAs or laboratory documentation may be available on relevant product pages or via our <a href='/coa' class='text-[#00E5FF] hover:underline font-medium'>COA & Lab Testing page</a>. Documentation availability, scope, and format vary by product and by testing cycle.",
            },
            { question: "Do Your Products Undergo Manufacturer Quality Control Testing?", answer: "Content for this section will be added here." },
            { question: "Do You Provide Third-Party Testing Verification?", answer: "Content for this section will be added here." },
            { question: "Can I Request Batch Or Lot Documentation Before My Order Is Dispatched?", answer: "Content for this section will be added here." },
            { question: "Can I Arrange Independent Testing Of My Order?", answer: "Content for this section will be added here." },
            { question: "How Can I Request Documentation Or Testing Information?", answer: "Content for this section will be added here." }
        ]
    },
    {
        title: "Orders & Shipping",
        items: [
            { question: "Where are orders dispatched from?", answer: "Orders are dispatched from our dispatch facility." },
            { question: "How Quickly Are Orders Processed?", answer: "Content for this section will be added here." },
            { question: "How Do I Receive Tracking Information?", answer: "Content for this section will be added here." },
            { question: "What Should I Do If My Order Is Delayed?", answer: "Content for this section will be added here." },
            { question: "How Long Do I Have To Complete Payment After Placing An Order?", answer: "Content for this section will be added here." },
            { question: "Do You Offer Worldwide Shipping?", answer: "Content for this section will be added here." },
            { question: "Will The Compound Degrade During Shipping Without Cold Packs?", answer: "Content for this section will be added here." },
            { question: "How Do Restock Alerts Work?", answer: "Content for this section will be added here." }
        ]
    },
    {
        title: "Refunds & Returns",
        items: [
            { question: "Where are orders dispatched from?", answer: "No. Due to the sensitive nature of lyophilised research compounds, we do not accept returns or offer refunds for \"change of mind\" or buyer's remorse. Once a product leaves our facility, we can no longer verify its environmental exposure or structural integrity. All sales of laboratory reagents are final, subject to your rights under applicable consumer protection laws and any other applicable non-excludable law." },
            { question: "What Do I Do If My Vials Arrive Damaged?", answer: "Content for this section will be added here." },
            { question: "Will I Get A Refund If My Package Is Seized By Customs?", answer: "Content for this section will be added here." },
            { question: "My Tracking Says \"Delivered\" But I Haven't Received It. Will You Refund Me?", answer: "Content for this section will be added here." }
        ]
    },
    {
        title: "Contact & Support",
        items: [
            { question: "How do I contact Solatide Biosciences?", answer: "Contact us via <a href='#' class='text-[#00E5FF] hover:underline font-medium'>Telegram or email</a>. We do not provide phone support. Our support team can assist with stock availability, order tracking, and damaged shipment claims." }
        ]
    }
];

async function seed() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to DB...");

        await FaqSection.deleteMany({});
        console.log("Cleared existing FAQs.");

        const sections = faqData.map((section, idx) => ({
            name: section.title,
            sortOrder: idx,
            questions: section.items.map((q, qIdx) => ({
                question: q.question,
                answer: q.answer,
                isVisible: true,
                sortOrder: qIdx
            }))
        }));

        await FaqSection.insertMany(sections);
        console.log("Seeded all FAQ sections from Faqs.jsx successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Error seeding:", err);
        process.exit(1);
    }
}

seed();
