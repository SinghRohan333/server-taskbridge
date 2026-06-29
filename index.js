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

// 1. Move database and collection definitions to the top scope
const db = client.db("taskbridge-db");
const usersCollection = db.collection("users");
const tasksCollection = db.collection("tasks");
const proposalsCollection = db.collection("proposals");
const paymentsCollection = db.collection("payments");
const reviewsCollection = db.collection("reviews");

// 2. Keep the async initialization logic isolated just for DB setup
async function initDatabase() {
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
        console.log(`Created collection: ${name}`);
      }
    }

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await tasksCollection.createIndex({ status: 1 });
    await tasksCollection.createIndex({ client_email: 1 });
    await proposalsCollection.createIndex({ task_id: 1 });
    await proposalsCollection.createIndex({ freelancer_email: 1 });

    console.log("Indexes ensured.");

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
    }
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
}

// Run DB seeding/indexing in the background
initDatabase();

// 3. Shared aggregation pipeline pieces
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

// ---------------------------------------------
// ROUTES (Now synchronously declared in outer scope)
// ---------------------------------------------

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

app.get("/api/tasks/latest", async (req, res) => {
  try {
    const tasks = await tasksCollection
      .aggregate([
        { $match: { status: "open" } },
        { $sort: { createdAt: -1 } },
        { $limit: 6 },
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
    res.status(200).json({ success: true, tasks });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch latest tasks." });
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid task ID format." });
    }
    const result = await tasksCollection
      .aggregate([
        { $match: { _id: new ObjectId(id) } },
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

    if (result.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Task not found." });
    }
    res.status(200).json({ success: true, task: result[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch task." });
  }
});

app.get("/api/users/freelancers", async (req, res) => {
  try {
    const freelancers = await usersCollection
      .aggregate(freelancerAggregationStages)
      .toArray();
    res.status(200).json({ success: true, freelancers });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch freelancers." });
  }
});

app.get("/api/users/freelancers/top", async (req, res) => {
  try {
    const freelancers = await usersCollection
      .aggregate([
        ...freelancerAggregationStages,
        { $sort: { averageRating: -1, completedJobsCount: -1 } },
        { $limit: 6 },
      ])
      .toArray();
    res.status(200).json({ success: true, freelancers });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch top freelancers." });
  }
});

app.get("/api/users/freelancers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid freelancer ID format." });
    }
    const result = await usersCollection
      .aggregate([
        { $match: { _id: new ObjectId(id) } },
        ...freelancerAggregationStages,
      ])
      .toArray();

    if (result.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Freelancer not found." });
    }
    res.status(200).json({ success: true, freelancer: result[0] });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch freelancer profile." });
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
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch platform stats." });
  }
});

app.post("/api/proposals", async (req, res) => {
  try {
    const {
      task_id,
      freelancer_email,
      proposed_budget,
      estimated_days,
      cover_note,
    } = req.body;
    if (
      !task_id ||
      !freelancer_email ||
      !proposed_budget ||
      !estimated_days ||
      !cover_note
    ) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });
    }
    const existing = await proposalsCollection.findOne({
      task_id,
      freelancer_email,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You have already submitted a proposal.",
      });
    }
    const proposal = {
      task_id,
      freelancer_email,
      proposed_budget: parseFloat(proposed_budget),
      estimated_days: parseInt(estimated_days, 10),
      cover_note,
      status: "pending",
      submitted_at: new Date(),
    };
    const result = await proposalsCollection.insertOne(proposal);
    res.status(201).json({
      success: true,
      message: "Proposal submitted successfully.",
      proposalId: result.insertedId,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to submit proposal." });
  }
});

app.get("/api/proposals/check", async (req, res) => {
  try {
    const { task_id, freelancer_email } = req.query;
    if (!task_id || !freelancer_email) {
      return res.status(400).json({
        success: false,
        message: "task_id and freelancer_email are required.",
      });
    }
    const existing = await proposalsCollection.findOne({
      task_id,
      freelancer_email,
    });
    res.status(200).json({ success: true, alreadyApplied: !!existing });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to check proposal status." });
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
