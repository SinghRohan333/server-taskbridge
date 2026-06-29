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
    // await client.connect();

    const db = client.db("taskbridge-db");

    // ---------------------------------------------
    // Collections setup (unchanged from Step 1.2)
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
    } else {
      console.log("Admin account already exists. Skipped seeding.");
    }

    // ---------------------------------------------
    // Shared aggregation pipeline pieces for freelancers
    // (joins avg rating from reviews + completed job count)
    // ---------------------------------------------

    const freelancerAggregationStages = [
      {
        $match: { role: "freelancer" },
      },
      {
        // Join reviews where this user is the one being reviewed
        $lookup: {
          from: "reviews",
          localField: "email",
          foreignField: "reviewee_email",
          as: "receivedReviews",
        },
      },
      {
        // Join proposals that were accepted, to count completed jobs
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
                      $expr: {
                        $eq: [{ $toString: "$_id" }, "$$taskIdStr"],
                      },
                      status: "completed",
                    },
                  },
                ],
                as: "completedTask",
              },
            },
            {
              $match: { completedTask: { $ne: [] } },
            },
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
    // PUBLIC TASK ROUTES
    // ---------------------------------------------

    // GET /api/tasks — open tasks, search + category filter + pagination
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
        res
          .status(500)
          .json({ success: false, message: "Failed to fetch tasks." });
      }
    });

    // GET /api/tasks/latest — latest 6 open tasks for home page
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
        console.error("GET /api/tasks/latest error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to fetch latest tasks." });
      }
    });

    // GET /api/tasks/:id — single task, with client name joined
    app.get("/api/tasks/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid task ID format.",
          });
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
            {
              $project: { clientInfo: 0 },
            },
          ])
          .toArray();

        if (result.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Task not found.",
          });
        }

        res.status(200).json({
          success: true,
          task: result[0],
        });
      } catch (error) {
        console.error("GET /api/tasks/:id error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch task.",
        });
      }
    });

    // ---------------------------------------------
    // PUBLIC FREELANCER ROUTES
    // ---------------------------------------------

    // GET /api/users/freelancers — all freelancers with rating + job count
    app.get("/api/users/freelancers", async (req, res) => {
      try {
        const freelancers = await usersCollection
          .aggregate(freelancerAggregationStages)
          .toArray();

        res.status(200).json({
          success: true,
          freelancers,
        });
      } catch (error) {
        console.error("GET /api/users/freelancers error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch freelancers.",
        });
      }
    });

    // GET /api/users/freelancers/top — top 6 by rating then job count
    app.get("/api/users/freelancers/top", async (req, res) => {
      try {
        const freelancers = await usersCollection
          .aggregate([
            ...freelancerAggregationStages,
            { $sort: { averageRating: -1, completedJobsCount: -1 } },
            { $limit: 6 },
          ])
          .toArray();

        res.status(200).json({
          success: true,
          freelancers,
        });
      } catch (error) {
        console.error("GET /api/users/freelancers/top error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch top freelancers.",
        });
      }
    });

    // GET /api/users/freelancers/:id — single freelancer public profile
    app.get("/api/users/freelancers/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid freelancer ID format.",
          });
        }

        const result = await usersCollection
          .aggregate([
            { $match: { _id: new ObjectId(id) } },
            ...freelancerAggregationStages,
          ])
          .toArray();

        if (result.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Freelancer not found.",
          });
        }

        res.status(200).json({
          success: true,
          freelancer: result[0],
        });
      } catch (error) {
        console.error("GET /api/users/freelancers/:id error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch freelancer profile.",
        });
      }
    });

    // ---------------------------------------------
    // PLATFORM STATS ROUTE
    // ---------------------------------------------

    // GET /api/stats — total tasks, total users, total successful payout
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
          stats: {
            totalTasks,
            totalUsers,
            totalPayout,
          },
        });
      } catch (error) {
        console.error("GET /api/stats error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch platform stats.",
        });
      }
    });

    // POST /api/proposals — submit a proposal (freelancer only)
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
          return res.status(400).json({
            success: false,
            message: "All fields are required.",
          });
        }

        // Check if this freelancer already applied to this task
        const existing = await proposalsCollection.findOne({
          task_id,
          freelancer_email,
        });

        if (existing) {
          return res.status(409).json({
            success: false,
            message: "You have already submitted a proposal for this task.",
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
        console.error("POST /api/proposals error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to submit proposal.",
        });
      }
    });

    // GET /api/proposals/check — check if freelancer already applied to a task
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

        res.status(200).json({
          success: true,
          alreadyApplied: !!existing,
        });
      } catch (error) {
        console.error("GET /api/proposals/check error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to check proposal status.",
        });
      }
    });
    // ---------------------------------------------
    // Root route (unchanged)
    // ---------------------------------------------

    app.get("/", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Welcome To Taskbridge Server",
      });
    });

    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log("Server is running on port: ", port);
});

module.exports = app;
