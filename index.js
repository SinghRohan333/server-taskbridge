const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 8000;
const app = express();

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

// 1. Instantiate the client globally so Vercel can cache the instance
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  // Serverless optimizations to gracefully recycle connections
  maxPoolSize: 10,
  minPoolSize: 0,
  socketTimeoutMS: 30000,
});

// 2. Define db and collections globally so they are instantly accessible
const db = client.db("taskbridge-db");
const usersCollection = db.collection("users");
const tasksCollection = db.collection("tasks");
const proposalsCollection = db.collection("proposals");
const paymentsCollection = db.collection("payments");
const reviewsCollection = db.collection("reviews");

// 3. SERVERLESS CONNECTION GUARD MIDDLEWARE
// This safely unfreezes and ensures a live connection pool on every request
app.use(async (req, res, next) => {
  if (req.path === "/") return next(); // Skip database check for the root route

  try {
    // If the connection is alive, this is a near-instant no-op.
    // If Vercel just unfroze the container, this re-establishes the dead socket cleanly.
    await client.connect();
    next();
  } catch (error) {
    console.error("MongoDB Serverless Connection Guard Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Database connection failed." });
  }
});

// 4. One-time DB Setup (Runs quietly in the background without blocking routes)
async function seedDatabase() {
  try {
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
      }
    }

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await tasksCollection.createIndex({ status: 1 });
    await tasksCollection.createIndex({ client_email: 1 });
    await proposalsCollection.createIndex({ task_id: 1 });
    await proposalsCollection.createIndex({ freelancer_email: 1 });

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
    }
    console.log("Database structural check & seeding complete.");
  } catch (err) {
    console.error("Background DB Seed Error:", err);
  }
}
seedDatabase();

// --- Shared Freelancer Aggregation Pipeline ---
const freelancerAggregationStages = [
  { $match: { role: "freelancer" } },
  {
    $lookup: {
      from: "reviews",
      localField: "email",
      foreignField: "reviewee_email",
      as: "receivedReviews",
    },
  },
  {
    $lookup: {
      from: "proposals",
      let: { freelancerEmail: "$email" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$freelancer_email", "$$freelancerEmail"] },
            status: "accepted",
          },
        },
        {
          $lookup: {
            from: "tasks",
            let: { taskIdStr: "$task_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: [{ $toString: "$_id" }, "$$taskIdStr"] },
                  status: "completed",
                },
              },
            ],
            as: "completedTask",
          },
        },
        { $match: { completedTask: { $ne: [] } } },
      ],
      as: "completedJobs",
    },
  },
  {
    $addFields: {
      averageRating: {
        $cond: [
          { $gt: [{ $size: "$receivedReviews" }, 0] },
          { $avg: "$receivedReviews.rating" },
          0,
        ],
      },
      totalReviews: { $size: "$receivedReviews" },
      completedJobsCount: { $size: "$completedJobs" },
    },
  },
  {
    $project: {
      password: 0,
      receivedReviews: 0,
      completedJobs: 0,
    },
  },
];

// --- ROUTES ---

app.get("/api/users/freelancers", async (req, res) => {
  try {
    const freelancers = await usersCollection
      .aggregate(freelancerAggregationStages)
      .toArray();
    res.status(200).json({ success: true, freelancers });
  } catch (error) {
    console.error("GET /api/users/freelancers error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch freelancers." });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const { search, category, page = 1, limit = 9 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 9, 1);
    const skip = (pageNum - 1) * limitNum;

    const filter = { status: "open" };
    if (search) filter.title = { $regex: search, $options: "i" };
    if (category) filter.category = category;

    const totalCount = await tasksCollection.countDocuments(filter);
    const tasks = await tasksCollection
      .aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limitNum },
        {
          $lookup: {
            from: "users",
            localField: "client_email",
            foreignField: "email",
            as: "clientInfo",
          },
        },
        {
          $addFields: {
            client_name: {
              $ifNull: [
                { $arrayElemAt: ["$clientInfo.name", 0] },
                "Unknown Client",
              ],
            },
          },
        },
        { $project: { clientInfo: 0 } },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      tasks,
      totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (error) {
    console.error("GET /api/tasks error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch tasks." });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const [totalTasks, totalUsers, payoutResult] = await Promise.all([
      tasksCollection.countDocuments({}),
      usersCollection.countDocuments({}),
      paymentsCollection
        .aggregate([
          { $match: { payment_status: "succeeded" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
    ]);
    const totalPayout = payoutResult.length > 0 ? payoutResult[0].total : 0;
    res.status(200).json({
      success: true,
      stats: { totalTasks, totalUsers, totalPayout },
    });
  } catch (error) {
    console.error("GET /api/stats error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch platform stats." });
  }
});

// Root Route
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome To Taskbridge Server",
  });
});

app.listen(port, () => {
  console.log("Server is running on port: ", port);
});
