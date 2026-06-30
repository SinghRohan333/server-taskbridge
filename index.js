const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

    // const existingAdmin = await usersCollection.findOne({
    //   email: "admin1@taskhive.com",
    // });
    // if (!existingAdmin) {
    //   await usersCollection.insertOne({
    //     name: "Admin",
    //     email: "admin1@taskhive.com",
    //     image: "",
    //     role: "admin",
    //     skills: [],
    //     bio: "",
    //     hourlyRate: 0,
    //     isBlocked: false,
    //     isVerified: true,
    //     createdAt: new Date(),
    //   });
    // }
    console.log("Database structural check & seeding complete.");
  } catch (err) {
    console.error("Background DB Seed Error:", err);
  }
}
seedDatabase();

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
    res.status(500).json({ success: false, message: "Failed to fetch tasks." });
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

// GET /api/tasks/client-stats — task counts by status + total spent
app.get("/api/tasks/client-stats", async (req, res) => {
  try {
    const { client_email } = req.query;

    if (!client_email) {
      return res.status(400).json({
        success: false,
        message: "client_email is required.",
      });
    }

    const [totalTasks, openTasks, inProgressTasks, spentResult] =
      await Promise.all([
        tasksCollection.countDocuments({ client_email }),
        tasksCollection.countDocuments({ client_email, status: "open" }),
        tasksCollection.countDocuments({
          client_email,
          status: "in-progress",
        }),
        paymentsCollection
          .aggregate([
            {
              $match: {
                client_email,
                payment_status: "succeeded",
              },
            },
            {
              $group: { _id: null, total: { $sum: "$amount" } },
            },
          ])
          .toArray(),
      ]);

    const totalSpent = spentResult.length > 0 ? spentResult[0].total : 0;

    res.status(200).json({
      success: true,
      stats: {
        totalTasks,
        openTasks,
        inProgressTasks,
        totalSpent,
      },
    });
  } catch (error) {
    console.error("GET /api/tasks/client-stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch client stats.",
    });
  }
});

// GET /api/tasks/mine — all tasks for a specific client
app.get("/api/tasks/mine", async (req, res) => {
  try {
    const { client_email } = req.query;

    if (!client_email) {
      return res.status(400).json({
        success: false,
        message: "client_email is required.",
      });
    }

    const tasks = await tasksCollection
      .aggregate([
        { $match: { client_email } },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "proposals",
            let: { taskIdStr: { $toString: "$_id" } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$task_id", "$$taskIdStr"] },
                  status: "accepted",
                },
              },
            ],
            as: "acceptedProposals",
          },
        },
        {
          $addFields: {
            hasAcceptedProposal: { $gt: [{ $size: "$acceptedProposals" }, 0] },
          },
        },
        { $project: { acceptedProposals: 0 } },
      ])
      .toArray();

    res.status(200).json({ success: true, tasks });
  } catch (error) {
    console.error("GET /api/tasks/mine error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch your tasks.",
    });
  }
});

// GET /api/tasks/active — in-progress tasks where freelancer has accepted proposal
app.get("/api/tasks/active", async (req, res) => {
  try {
    const { freelancer_email } = req.query;

    if (!freelancer_email) {
      return res.status(400).json({
        success: false,
        message: "freelancer_email is required.",
      });
    }

    const acceptedProposals = await proposalsCollection
      .find({ freelancer_email, status: "accepted" })
      .toArray();

    if (acceptedProposals.length === 0) {
      return res.status(200).json({ success: true, tasks: [] });
    }

    const taskIds = acceptedProposals
      .map((p) => {
        try {
          return new ObjectId(p.task_id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const tasks = await tasksCollection
      .aggregate([
        {
          $match: {
            _id: { $in: taskIds },
            status: { $in: ["in-progress", "completed"] },
          },
        },
        { $sort: { createdAt: -1 } },
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

    // Attach proposal info (budget accepted, days) to each task
    const proposalByTaskId = {};
    for (const p of acceptedProposals) {
      proposalByTaskId[p.task_id] = p;
    }

    const tasksWithProposal = tasks.map((task) => ({
      ...task,
      proposal: proposalByTaskId[task._id.toString()] || null,
    }));

    res.status(200).json({ success: true, tasks: tasksWithProposal });
  } catch (error) {
    console.error("GET /api/tasks/active error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch active tasks." });
  }
});

// PATCH /api/tasks/:id — edit a task (only if status is open)
app.patch("/api/tasks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { client_email, title, category, description, budget, deadline } =
      req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid task ID.",
      });
    }

    const task = await tasksCollection.findOne({ _id: new ObjectId(id) });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found.",
      });
    }

    if (task.client_email !== client_email) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to edit this task.",
      });
    }

    if (task.status !== "open") {
      return res.status(403).json({
        success: false,
        message: "Only open tasks can be edited.",
      });
    }

    await tasksCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          title: title.trim(),
          category,
          description: description.trim(),
          budget: parseFloat(budget),
          deadline,
          updatedAt: new Date(),
        },
      },
    );

    res.status(200).json({
      success: true,
      message: "Task updated successfully.",
    });
  } catch (error) {
    console.error("PATCH /api/tasks/:id error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update task.",
    });
  }
});

// DELETE /api/tasks/:id — delete a task (only if no accepted proposal)
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { client_email } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid task ID.",
      });
    }

    const task = await tasksCollection.findOne({ _id: new ObjectId(id) });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found.",
      });
    }

    if (task.client_email !== client_email) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to delete this task.",
      });
    }

    const acceptedProposal = await proposalsCollection.findOne({
      task_id: id,
      status: "accepted",
    });

    if (acceptedProposal) {
      return res.status(400).json({
        success: false,
        message: "This task has an accepted proposal and cannot be deleted.",
      });
    }

    await tasksCollection.deleteOne({ _id: new ObjectId(id) });

    res.status(200).json({
      success: true,
      message: "Task deleted successfully.",
    });
  } catch (error) {
    console.error("DELETE /api/tasks/:id error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete task.",
    });
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

// GET /api/reviews — all reviews for a freelancer, with reviewer name joined
app.get("/api/reviews", async (req, res) => {
  try {
    const { reviewee_email } = req.query;

    if (!reviewee_email) {
      return res.status(400).json({
        success: false,
        message: "reviewee_email is required.",
      });
    }

    const reviews = await reviewsCollection
      .aggregate([
        { $match: { reviewee_email } },
        { $sort: { created_at: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "reviewer_email",
            foreignField: "email",
            as: "reviewerInfo",
          },
        },
        {
          $addFields: {
            reviewer_name: {
              $ifNull: [
                { $arrayElemAt: ["$reviewerInfo.name", 0] },
                "Anonymous",
              ],
            },
            reviewer_image: {
              $ifNull: [{ $arrayElemAt: ["$reviewerInfo.image", 0] }, ""],
            },
          },
        },
        { $project: { reviewerInfo: 0 } },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      reviews,
    });
  } catch (error) {
    console.error("GET /api/reviews error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch reviews.",
    });
  }
});

// POST /api/tasks — create a new task (client only, auth enforced on frontend)
app.post("/api/tasks", async (req, res) => {
  try {
    const { title, category, description, budget, deadline, client_email } =
      req.body;

    // NOTE: client_email is trusted from the frontend session.
    // Full JWT verification is deferred to Challenge 2 implementation.
    if (
      !title ||
      !category ||
      !description ||
      !budget ||
      !deadline ||
      !client_email
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required.",
      });
    }

    if (typeof budget !== "number" || budget <= 0) {
      return res.status(400).json({
        success: false,
        message: "Budget must be a positive number.",
      });
    }

    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "Deadline must be a valid future date.",
      });
    }

    const task = {
      title: title.trim(),
      category,
      description: description.trim(),
      budget,
      deadline: deadlineDate,
      client_email,
      status: "open",
      deliverable_url: "",
      createdAt: new Date(),
    };

    const result = await tasksCollection.insertOne(task);

    res.status(201).json({
      success: true,
      message: "Task posted successfully.",
      taskId: result.insertedId,
    });
  } catch (error) {
    console.error("POST /api/tasks error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to post task.",
    });
  }
});

// GET /api/proposals/client — all proposals grouped by task for a client
app.get("/api/proposals/client", async (req, res) => {
  try {
    const { client_email } = req.query;

    if (!client_email) {
      return res.status(400).json({
        success: false,
        message: "client_email is required.",
      });
    }

    // Get all tasks belonging to this client
    const clientTasks = await tasksCollection.find({ client_email }).toArray();

    if (clientTasks.length === 0) {
      return res.status(200).json({ success: true, groups: [] });
    }

    const taskIds = clientTasks.map((t) => t._id.toString());

    // Get all proposals for those tasks
    const proposals = await proposalsCollection
      .aggregate([
        { $match: { task_id: { $in: taskIds } } },
        { $sort: { submitted_at: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "freelancer_email",
            foreignField: "email",
            as: "freelancerInfo",
          },
        },
        {
          $addFields: {
            freelancer_name: {
              $ifNull: [
                { $arrayElemAt: ["$freelancerInfo.name", 0] },
                "Unknown Freelancer",
              ],
            },
            freelancer_image: {
              $arrayElemAt: ["$freelancerInfo.image", 0],
            },
          },
        },
        { $project: { freelancerInfo: 0 } },
      ])
      .toArray();

    // Group proposals by task_id
    const proposalsByTaskId = {};
    for (const proposal of proposals) {
      if (!proposalsByTaskId[proposal.task_id]) {
        proposalsByTaskId[proposal.task_id] = [];
      }
      proposalsByTaskId[proposal.task_id].push(proposal);
    }

    // Build groups — only tasks that have at least one proposal
    const groups = clientTasks
      .filter((task) => proposalsByTaskId[task._id.toString()]?.length > 0)
      .map((task) => ({
        task: {
          _id: task._id.toString(),
          title: task.title,
          category: task.category,
          budget: task.budget,
          status: task.status,
        },
        proposals: proposalsByTaskId[task._id.toString()],
      }));

    res.status(200).json({ success: true, groups });
  } catch (error) {
    console.error("GET /api/proposals/client error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch proposals.",
    });
  }
});

// PATCH /api/proposals/:id/reject — reject a proposal
app.patch("/api/proposals/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;
    const { client_email } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid proposal ID.",
      });
    }

    const proposal = await proposalsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: "Proposal not found.",
      });
    }

    // Verify the client owns the task this proposal belongs to
    const task = await tasksCollection.findOne({
      _id: new ObjectId(proposal.task_id),
      client_email,
    });

    if (!task) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to reject this proposal.",
      });
    }

    await proposalsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "rejected" } },
    );

    res.status(200).json({
      success: true,
      message: "Proposal rejected.",
    });
  } catch (error) {
    console.error("PATCH /api/proposals/:id/reject error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reject proposal.",
    });
  }
});

// POST /api/stripe/create-checkout — create Stripe checkout session
app.post("/api/stripe/create-checkout", async (req, res) => {
  try {
    const { proposal_id, task_id, client_email } = req.body;

    if (!proposal_id || !task_id || !client_email) {
      return res.status(400).json({
        success: false,
        message: "proposal_id, task_id, and client_email are required.",
      });
    }

    const task = await tasksCollection.findOne({
      _id: new ObjectId(task_id),
      client_email,
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found.",
      });
    }

    const proposal = await proposalsCollection.findOne({
      _id: new ObjectId(proposal_id),
    });

    if (!proposal) {
      return res.status(404).json({
        success: false,
        message: "Proposal not found.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: task.title,
              description: `Freelancer proposal for: ${task.title}`,
            },
            unit_amount: Math.round(proposal.proposed_budget * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        proposal_id: proposal_id.toString(),
        task_id: task_id.toString(),
        client_email,
        freelancer_email: proposal.freelancer_email,
      },
      success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/client/proposals`,
    });

    res.status(200).json({ success: true, url: session.url });
  } catch (error) {
    console.error("POST /api/stripe/create-checkout error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create checkout session.",
    });
  }
});

// GET /api/stripe/confirm-session — confirm payment and update records
app.get("/api/stripe/confirm-session", async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        message: "session_id is required.",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Payment has not been completed.",
      });
    }

    const { proposal_id, task_id, client_email, freelancer_email } =
      session.metadata;

    // Check if already processed (idempotency)
    const existingPayment = await paymentsCollection.findOne({
      transaction_id: session.payment_intent,
    });

    if (existingPayment) {
      // Already processed — just return the summary
      const task = await tasksCollection.findOne({
        _id: new ObjectId(task_id),
      });
      const freelancer = await usersCollection.findOne({
        email: freelancer_email,
      });

      return res.status(200).json({
        success: true,
        alreadyProcessed: true,
        summary: {
          taskTitle: task?.title || "Task",
          freelancerName: freelancer?.name || "Freelancer",
          amount: session.amount_total / 100,
        },
      });
    }

    // Mark accepted proposal
    await proposalsCollection.updateOne(
      { _id: new ObjectId(proposal_id) },
      { $set: { status: "accepted" } },
    );

    // Reject all other proposals for this task
    await proposalsCollection.updateMany(
      {
        task_id,
        _id: { $ne: new ObjectId(proposal_id) },
      },
      { $set: { status: "rejected" } },
    );

    // Update task to in-progress
    await tasksCollection.updateOne(
      { _id: new ObjectId(task_id) },
      { $set: { status: "in-progress" } },
    );

    // Insert payment record
    await paymentsCollection.insertOne({
      client_email,
      freelancer_email,
      task_id,
      amount: session.amount_total / 100,
      transaction_id: session.payment_intent,
      payment_status: "succeeded",
      paid_at: new Date(),
    });

    const task = await tasksCollection.findOne({
      _id: new ObjectId(task_id),
    });
    const freelancer = await usersCollection.findOne({
      email: freelancer_email,
    });

    res.status(200).json({
      success: true,
      summary: {
        taskTitle: task?.title || "Task",
        freelancerName: freelancer?.name || "Freelancer",
        amount: session.amount_total / 100,
      },
    });
  } catch (error) {
    console.error("GET /api/stripe/confirm-session error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to confirm payment.",
    });
  }
});

// GET /api/payments/client — payment history for a client
app.get("/api/payments/client", async (req, res) => {
  try {
    const { client_email } = req.query;

    if (!client_email) {
      return res.status(400).json({
        success: false,
        message: "client_email is required.",
      });
    }

    const payments = await paymentsCollection
      .aggregate([
        { $match: { client_email, payment_status: "succeeded" } },
        { $sort: { paid_at: -1 } },
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
                },
              },
            ],
            as: "taskInfo",
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "freelancer_email",
            foreignField: "email",
            as: "freelancerInfo",
          },
        },
        {
          $addFields: {
            task_title: {
              $ifNull: [
                { $arrayElemAt: ["$taskInfo.title", 0] },
                "Deleted Task",
              ],
            },
            freelancer_name: {
              $ifNull: [
                { $arrayElemAt: ["$freelancerInfo.name", 0] },
                "Unknown Freelancer",
              ],
            },
          },
        },
        { $project: { taskInfo: 0, freelancerInfo: 0 } },
      ])
      .toArray();

    res.status(200).json({ success: true, payments });
  } catch (error) {
    console.error("GET /api/payments/client error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch payment history.",
    });
  }
});

// GET /api/proposals/freelancer-stats — overview stats for freelancer dashboard
app.get("/api/proposals/freelancer-stats", async (req, res) => {
  try {
    const { freelancer_email } = req.query;

    if (!freelancer_email) {
      return res.status(400).json({
        success: false,
        message: "freelancer_email is required.",
      });
    }

    const [total, pending, accepted, rejected, earningsResult] =
      await Promise.all([
        proposalsCollection.countDocuments({ freelancer_email }),
        proposalsCollection.countDocuments({
          freelancer_email,
          status: "pending",
        }),
        proposalsCollection.countDocuments({
          freelancer_email,
          status: "accepted",
        }),
        proposalsCollection.countDocuments({
          freelancer_email,
          status: "rejected",
        }),
        paymentsCollection
          .aggregate([
            { $match: { freelancer_email, payment_status: "succeeded" } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray(),
      ]);

    const totalEarnings =
      earningsResult.length > 0 ? earningsResult[0].total : 0;

    res.status(200).json({
      success: true,
      stats: { total, pending, accepted, rejected, totalEarnings },
    });
  } catch (error) {
    console.error("GET /api/proposals/freelancer-stats error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch stats." });
  }
});

// GET /api/proposals/mine — all proposals for a freelancer with task title
app.get("/api/proposals/mine", async (req, res) => {
  try {
    const { freelancer_email } = req.query;

    if (!freelancer_email) {
      return res.status(400).json({
        success: false,
        message: "freelancer_email is required.",
      });
    }

    const proposals = await proposalsCollection
      .aggregate([
        { $match: { freelancer_email } },
        { $sort: { submitted_at: -1 } },
        {
          $addFields: { taskObjectId: { $toObjectId: "$task_id" } },
        },
        {
          $lookup: {
            from: "tasks",
            localField: "taskObjectId",
            foreignField: "_id",
            as: "taskInfo",
          },
        },
        {
          $addFields: {
            task_title: {
              $ifNull: [
                { $arrayElemAt: ["$taskInfo.title", 0] },
                "Deleted Task",
              ],
            },
            task_category: {
              $ifNull: [{ $arrayElemAt: ["$taskInfo.category", 0] }, "Other"],
            },
            task_status: {
              $ifNull: [{ $arrayElemAt: ["$taskInfo.status", 0] }, "unknown"],
            },
          },
        },
        { $project: { taskInfo: 0, taskObjectId: 0 } },
      ])
      .toArray();

    res.status(200).json({ success: true, proposals });
  } catch (error) {
    console.error("GET /api/proposals/mine error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch proposals." });
  }
});

// PATCH /api/tasks/:id/complete — submit deliverable and mark task completed
app.patch("/api/tasks/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { freelancer_email, deliverable_url } = req.body;

    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid task ID." });
    }

    if (!deliverable_url || !deliverable_url.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Deliverable URL is required." });
    }

    // Verify this freelancer has an accepted proposal for this task
    const proposal = await proposalsCollection.findOne({
      task_id: id,
      freelancer_email,
      status: "accepted",
    });

    if (!proposal) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to complete this task.",
      });
    }

    await tasksCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { status: "completed", deliverable_url: deliverable_url.trim() },
      },
    );

    res
      .status(200)
      .json({ success: true, message: "Task marked as completed." });
  } catch (error) {
    console.error("PATCH /api/tasks/:id/complete error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to complete task." });
  }
});

// GET /api/payments/freelancer — earnings history for a freelancer
app.get("/api/payments/freelancer", async (req, res) => {
  try {
    const { freelancer_email } = req.query;

    if (!freelancer_email) {
      return res.status(400).json({
        success: false,
        message: "freelancer_email is required.",
      });
    }

    const payments = await paymentsCollection
      .aggregate([
        { $match: { freelancer_email, payment_status: "succeeded" } },
        { $sort: { paid_at: -1 } },
        {
          $lookup: {
            from: "tasks",
            let: { taskIdStr: "$task_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: [{ $toString: "$_id" }, "$$taskIdStr"] },
                },
              },
            ],
            as: "taskInfo",
          },
        },
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
            task_title: {
              $ifNull: [
                { $arrayElemAt: ["$taskInfo.title", 0] },
                "Deleted Task",
              ],
            },
            task_id_obj: { $arrayElemAt: ["$taskInfo._id", 0] },
            client_name: {
              $ifNull: [
                { $arrayElemAt: ["$clientInfo.name", 0] },
                "Unknown Client",
              ],
            },
          },
        },
        { $project: { taskInfo: 0, clientInfo: 0 } },
      ])
      .toArray();

    res.status(200).json({ success: true, payments });
  } catch (error) {
    console.error("GET /api/payments/freelancer error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch earnings." });
  }
});

// POST /api/reviews — submit a review after task completion
app.post("/api/reviews", async (req, res) => {
  try {
    const { task_id, reviewer_email, reviewee_email, rating, comment } =
      req.body;

    if (!task_id || !reviewer_email || !reviewee_email || !rating) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });
    }

    if (rating < 1 || rating > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be between 1 and 5." });
    }

    const existing = await reviewsCollection.findOne({
      task_id,
      reviewer_email,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this task.",
      });
    }

    await reviewsCollection.insertOne({
      task_id,
      reviewer_email,
      reviewee_email,
      rating: parseInt(rating, 10),
      comment: comment?.trim() || "",
      created_at: new Date(),
    });

    res
      .status(201)
      .json({ success: true, message: "Review submitted successfully." });
  } catch (error) {
    console.error("POST /api/reviews error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to submit review." });
  }
});

// GET /api/reviews/check — check if freelancer already reviewed a task
app.get("/api/reviews/check", async (req, res) => {
  try {
    const { task_id, reviewer_email } = req.query;

    if (!task_id || !reviewer_email) {
      return res.status(400).json({
        success: false,
        message: "task_id and reviewer_email are required.",
      });
    }

    const existing = await reviewsCollection.findOne({
      task_id,
      reviewer_email,
    });
    res.status(200).json({ success: true, alreadyReviewed: !!existing });
  } catch (error) {
    console.error("GET /api/reviews/check error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to check review status." });
  }
});

// PATCH /api/users/me — update freelancer profile
app.patch("/api/users/me", async (req, res) => {
  try {
    const { email, name, image, skills, bio, hourlyRate } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "email is required." });
    }

    const updateFields = {};
    if (name !== undefined) updateFields.name = name.trim();
    if (image !== undefined) updateFields.image = image.trim();
    if (skills !== undefined) updateFields.skills = skills;
    if (bio !== undefined) updateFields.bio = bio.trim();
    if (hourlyRate !== undefined)
      updateFields.hourlyRate = parseFloat(hourlyRate) || 0;

    await usersCollection.updateOne({ email }, { $set: updateFields });

    const updatedUser = await usersCollection.findOne(
      { email },
      { projection: { password: 0 } },
    );

    res.status(200).json({ success: true, user: updatedUser });
  } catch (error) {
    console.error("PATCH /api/users/me error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update profile." });
  }
});

// ---------------------------------------------
// ADMIN ROLE GUARD
// ---------------------------------------------
// NOTE: same trust model as the rest of this API today (email passed by the
// caller, looked up server-side). This is a stand-in until Challenge 2 wires
// up real JWT verification across the whole app — at that point, swap this
// out for a cookie/token check instead of trusting a passed-in email.
function roleGuard(allowedRoles) {
  return async (req, res, next) => {
    const adminEmail = req.query.admin_email || req.body.admin_email;

    if (!adminEmail) {
      return res.status(401).json({
        success: false,
        message: "Missing admin_email — request is not authenticated.",
      });
    }

    try {
      const actingUser = await usersCollection.findOne({ email: adminEmail });

      if (!actingUser) {
        return res
          .status(401)
          .json({ success: false, message: "User not found." });
      }

      if (actingUser.isBlocked) {
        return res
          .status(403)
          .json({ success: false, message: "Account suspended." });
      }

      if (!allowedRoles.includes(actingUser.role)) {
        return res
          .status(403)
          .json({ success: false, message: "Forbidden — insufficient role." });
      }

      req.actingUser = actingUser;
      next();
    } catch (error) {
      console.error("roleGuard error:", error);
      res
        .status(500)
        .json({ success: false, message: "Authorization check failed." });
    }
  };
}

// ---------------------------------------------
// ADMIN ROUTES
// ---------------------------------------------

// GET /api/admin/stats
app.get("/api/admin/stats", roleGuard(["admin"]), async (req, res) => {
  try {
    const [totalUsers, totalTasks, activeTasks, revenueResult] =
      await Promise.all([
        usersCollection.countDocuments({}),
        tasksCollection.countDocuments({}),
        tasksCollection.countDocuments({ status: { $ne: "completed" } }),
        paymentsCollection
          .aggregate([
            { $match: { payment_status: "succeeded" } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray(),
      ]);

    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

    res.status(200).json({
      success: true,
      stats: { totalUsers, totalTasks, totalRevenue, activeTasks },
    });
  } catch (error) {
    console.error("GET /api/admin/stats error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch admin stats." });
  }
});

// GET /api/admin/users
app.get("/api/admin/users", roleGuard(["admin"]), async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, users });
  } catch (error) {
    console.error("GET /api/admin/users error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch users." });
  }
});

// PATCH /api/admin/users/:id/block
app.patch(
  "/api/admin/users/:id/block",
  roleGuard(["admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID." });
      }

      const targetUser = await usersCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!targetUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }
      if (targetUser.role === "admin") {
        return res
          .status(400)
          .json({
            success: false,
            message: "Admin accounts cannot be blocked.",
          });
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isBlocked: true } },
      );
      res.status(200).json({ success: true, message: "User blocked." });
    } catch (error) {
      console.error("PATCH /api/admin/users/:id/block error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to block user." });
    }
  },
);

// PATCH /api/admin/users/:id/unblock
app.patch(
  "/api/admin/users/:id/unblock",
  roleGuard(["admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID." });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isBlocked: false } },
      );
      if (result.matchedCount === 0) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }

      res.status(200).json({ success: true, message: "User unblocked." });
    } catch (error) {
      console.error("PATCH /api/admin/users/:id/unblock error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to unblock user." });
    }
  },
);

// PATCH /api/admin/users/:id/verify
app.patch(
  "/api/admin/users/:id/verify",
  roleGuard(["admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID." });
      }

      const targetUser = await usersCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!targetUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }
      if (targetUser.role !== "freelancer") {
        return res.status(400).json({
          success: false,
          message: "Only freelancer accounts can be verified.",
        });
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isVerified: true } },
      );
      res.status(200).json({ success: true, message: "Freelancer verified." });
    } catch (error) {
      console.error("PATCH /api/admin/users/:id/verify error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to verify user." });
    }
  },
);

// GET /api/admin/tasks
app.get("/api/admin/tasks", roleGuard(["admin"]), async (req, res) => {
  try {
    const tasks = await tasksCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, tasks });
  } catch (error) {
    console.error("GET /api/admin/tasks error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch tasks." });
  }
});

// DELETE /api/admin/tasks/:id
app.delete("/api/admin/tasks/:id", roleGuard(["admin"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid task ID." });
    }

    const result = await tasksCollection.deleteOne({
      _id: new ObjectId(id),
    });
    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Task not found." });
    }

    res.status(200).json({ success: true, message: "Task deleted." });
  } catch (error) {
    console.error("DELETE /api/admin/tasks/:id error:", error);
    res.status(500).json({ success: false, message: "Failed to delete task." });
  }
});

// GET /api/admin/transactions
app.get("/api/admin/transactions", roleGuard(["admin"]), async (req, res) => {
  try {
    const transactions = await paymentsCollection
      .find({})
      .sort({ paid_at: -1 })
      .toArray();

    res.status(200).json({ success: true, transactions });
  } catch (error) {
    console.error("GET /api/admin/transactions error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch transactions." });
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

app.listen(port, () => {
  console.log("Server is running on port: ", port);
});
