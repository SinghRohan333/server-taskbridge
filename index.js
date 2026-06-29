const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 8000;

const app = express();

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("taskbridge-db");

    // ---------------------------------------------
    // Collections (5 total)
    // Field shapes (agreed convention, not DB-enforced):
    //
    // users: name, email, image, role (client/freelancer/admin),
    //        skills[], bio, hourlyRate, isBlocked, isVerified, createdAt
    //
    // tasks: title, category, description, budget, deadline,
    //        client_email, status (open/in-progress/completed),
    //        deliverable_url, createdAt
    //
    // proposals: task_id, freelancer_email, proposed_budget,
    //            estimated_days, cover_note,
    //            status (pending/accepted/rejected), submitted_at
    //
    // payments: client_email, freelancer_email, task_id, amount,
    //           transaction_id, payment_status, paid_at
    //
    // reviews: task_id, reviewer_email, reviewee_email, rating,
    //          comment, created_at
    // ---------------------------------------------

    const existingCollections = await db.listCollections().toArray();
    const existingNames = existingCollections.map((col) => col.name);

    const requiredCollections = [
      "users",
      "tasks",
      "proposals",
      "payments",
      "reviews",
    ];

    for (const name of requiredCollections) {
      if (!existingNames.includes(name)) {
        await db.createCollection(name);
        console.log(`Created collection: ${name}`);
      }
    }

    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");
    const proposalsCollection = db.collection("proposals");
    const paymentsCollection = db.collection("payments");
    const reviewsCollection = db.collection("reviews");

    // ---------------------------------------------
    // Indexes
    // ---------------------------------------------

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await tasksCollection.createIndex({ status: 1 });
    await tasksCollection.createIndex({ client_email: 1 });
    await proposalsCollection.createIndex({ task_id: 1 });
    await proposalsCollection.createIndex({ freelancer_email: 1 });

    console.log("Indexes ensured.");

    // ---------------------------------------------
    // Seed Admin Account
    // ---------------------------------------------

    const existingAdmin = await usersCollection.findOne({
      email: "admin1@taskhive.com",
    });

    if (!existingAdmin) {
      await usersCollection.insertOne({
        name: "Admin",
        email: "admin1@taskhive.com",
        image: "",
        role: "admin",
        skills: [],
        bio: "",
        hourlyRate: 0,
        isBlocked: false,
        isVerified: true,
        createdAt: new Date(),
      });
      console.log("Admin account seeded.");
    } else {
      console.log("Admin account already exists. Skipped seeding.");
    }

    app.get("/", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Welcome To Taskbridge Server",
      });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log("Server is running on port: ", port);
});
