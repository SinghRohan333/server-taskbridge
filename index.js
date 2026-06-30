const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 8000;

// jose is ESM-only; loaded once via dynamic import for use in this CommonJS file
let JWKS;
async function getJWKS() {
  if (!JWKS) {
    const { createRemoteJWKSet } = await import("jose");
    JWKS = createRemoteJWKSet(
      new URL(`${process.env.FRONTEND_URL}/api/auth/jwks`),
    );
  }
  return JWKS;
}

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
  maxPoolSize: 10,
  minPoolSize: 0,
  socketTimeoutMS: 30000,
});

const db = client.db("taskbridge-db");
const usersCollection = db.collection("users");
const tasksCollection = db.collection("tasks");
const proposalsCollection = db.collection("proposals");
const paymentsCollection = db.collection("payments");
const reviewsCollection = db.collection("reviews");
const notificationsCollection = db.collection("notifications");

app.use(async (req, res, next) => {
  if (req.path === "/") return next();

  try {
    await client.connect();
    next();
  } catch (error) {
    console.error("MongoDB Serverless Connection Guard Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Database connection failed." });
  }
});

async function verifyJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing authentication token.",
      });
    }

    const { jwtVerify } = await import("jose");
    const jwks = await getJWKS();

    const { payload } = await jwtVerify(token, jwks, {
      issuer: process.env.FRONTEND_URL,
      audience: process.env.FRONTEND_URL,
    });

    const dbUser = await usersCollection.findOne({ email: payload.email });

    if (!dbUser) {
      return res
        .status(401)
        .json({ success: false, message: "User not found." });
    }
    if (dbUser.isBlocked) {
      return res
        .status(403)
        .json({ success: false, message: "Account suspended." });
    }

    req.user = { email: dbUser.email, role: dbUser.role, name: dbUser.name };
    next();
  } catch (error) {
    console.error("verifyJWT error:", error.message);
    res
      .status(401)
      .json({ success: false, message: "Invalid or expired token." });
  }
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, message: "Forbidden — insufficient role." });
    }
    next();
  };
}

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
      "notifications",
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
    await notificationsCollection.createIndex({ user_email: 1, is_read: 1 });

    console.log("Database structural check & seeding complete.");
  } catch (err) {
    console.error("Background DB Seed Error:", err);
  }
}
seedDatabase();

const freelancerAggregationStages = [
  {
    $match: { role: "freelancer" },
  },
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
    console.error("GET /api/tasks/latest error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch latest tasks." });
  }
});

app.get(
  "/api/tasks/client-stats",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
  },
);

app.get(
  "/api/tasks/mine",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
              hasAcceptedProposal: {
                $gt: [{ $size: "$acceptedProposals" }, 0],
              },
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
  },
);

app.get(
  "/api/tasks/active",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
  },
);

app.patch(
  "/api/tasks/:id",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
  },
);

app.delete(
  "/api/tasks/:id",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
  },
);

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

app.post(
  "/api/proposals",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
  },
);

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

app.post("/api/tasks", verifyJWT, requireRole(["client"]), async (req, res) => {
  try {
    const { title, category, description, budget, deadline, client_email } =
      req.body;

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

app.get(
  "/api/proposals/client",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
    try {
      const { client_email } = req.query;

      if (!client_email) {
        return res.status(400).json({
          success: false,
          message: "client_email is required.",
        });
      }

      const clientTasks = await tasksCollection
        .find({ client_email })
        .toArray();

      if (clientTasks.length === 0) {
        return res.status(200).json({ success: true, groups: [] });
      }

      const taskIds = clientTasks.map((t) => t._id.toString());

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

      const proposalsByTaskId = {};
      for (const proposal of proposals) {
        if (!proposalsByTaskId[proposal.task_id]) {
          proposalsByTaskId[proposal.task_id] = [];
        }
        proposalsByTaskId[proposal.task_id].push(proposal);
      }

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
  },
);

app.post(
  "/api/stripe/create-checkout",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
  },
);

app.get(
  "/api/payments/client",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
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
  },
);

app.get(
  "/api/proposals/freelancer-stats",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch stats." });
    }
  },
);

app.get(
  "/api/proposals/mine",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
  },
);

app.patch(
  "/api/tasks/:id/complete",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
          $set: {
            status: "completed",
            deliverable_url: deliverable_url.trim(),
          },
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
  },
);

app.get(
  "/api/payments/freelancer",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
  },
);

app.get(
  "/api/reviews/check",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
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
  },
);

app.patch("/api/users/me", verifyJWT, async (req, res) => {
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
// ADMIN ROUTES
// ---------------------------------------------

app.get(
  "/api/admin/stats",
  verifyJWT,
  requireRole(["admin"]),
  async (req, res) => {
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

      const totalRevenue =
        revenueResult.length > 0 ? revenueResult[0].total : 0;

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
  },
);

app.get(
  "/api/admin/users",
  verifyJWT,
  requireRole(["admin"]),
  async (req, res) => {
    try {
      const users = await usersCollection
        .find({}, { projection: { password: 0 } })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).json({ success: true, users });
    } catch (error) {
      console.error("GET /api/admin/users error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch users." });
    }
  },
);

app.patch(
  "/api/admin/users/:id/block",
  verifyJWT,
  requireRole(["admin"]),
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
        return res.status(400).json({
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

app.patch(
  "/api/admin/users/:id/unblock",
  verifyJWT,
  requireRole(["admin"]),
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

app.patch(
  "/api/admin/users/:id/verify",
  verifyJWT,
  requireRole(["admin"]),
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

app.get(
  "/api/admin/tasks",
  verifyJWT,
  requireRole(["admin"]),
  async (req, res) => {
    try {
      const tasks = await tasksCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();
      res.status(200).json({ success: true, tasks });
    } catch (error) {
      console.error("GET /api/admin/tasks error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch tasks." });
    }
  },
);

app.delete(
  "/api/admin/tasks/:id",
  verifyJWT,
  requireRole(["admin"]),
  async (req, res) => {
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
      res
        .status(500)
        .json({ success: false, message: "Failed to delete task." });
    }
  },
);

app.get(
  "/api/admin/transactions",
  verifyJWT,
  requireRole(["admin"]),
  async (req, res) => {
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
  },
);

// ---------------------------------------------
// BOOKMARKS (Step 7.1)
// ---------------------------------------------

app.post(
  "/api/bookmarks/:taskId",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
    try {
      const { taskId } = req.params;
      if (!ObjectId.isValid(taskId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid task ID." });
      }

      const user = await usersCollection.findOne({ email: req.user.email });
      const bookmarks = user?.bookmarks || [];
      const alreadyBookmarked = bookmarks.includes(taskId);

      await usersCollection.updateOne(
        { email: req.user.email },
        alreadyBookmarked
          ? { $pull: { bookmarks: taskId } }
          : { $addToSet: { bookmarks: taskId } },
      );

      res.status(200).json({
        success: true,
        bookmarked: !alreadyBookmarked,
        message: alreadyBookmarked ? "Bookmark removed." : "Task bookmarked.",
      });
    } catch (error) {
      console.error("POST /api/bookmarks/:taskId error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to toggle bookmark." });
    }
  },
);

app.get(
  "/api/bookmarks",
  verifyJWT,
  requireRole(["freelancer"]),
  async (req, res) => {
    try {
      const user = await usersCollection.findOne({ email: req.user.email });
      const bookmarkIds = (user?.bookmarks || [])
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      if (bookmarkIds.length === 0) {
        return res
          .status(200)
          .json({ success: true, tasks: [], bookmarkedIds: [] });
      }

      const tasks = await tasksCollection
        .aggregate([
          { $match: { _id: { $in: bookmarkIds } } },
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

      res
        .status(200)
        .json({ success: true, tasks, bookmarkedIds: user.bookmarks || [] });
    } catch (error) {
      console.error("GET /api/bookmarks error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch bookmarks." });
    }
  },
);

// ---------------------------------------------
// NOTIFICATIONS (Step 7.1)
// ---------------------------------------------

app.get("/api/notifications/mine", verifyJWT, async (req, res) => {
  try {
    const notifications = await notificationsCollection
      .find({ user_email: req.user.email, is_read: false })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();

    res.status(200).json({ success: true, notifications });
  } catch (error) {
    console.error("GET /api/notifications/mine error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch notifications." });
  }
});

app.patch("/api/notifications/read", verifyJWT, async (req, res) => {
  try {
    await notificationsCollection.updateMany(
      { user_email: req.user.email, is_read: false },
      { $set: { is_read: true } },
    );
    res
      .status(200)
      .json({ success: true, message: "Notifications marked as read." });
  } catch (error) {
    console.error("PATCH /api/notifications/read error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update notifications." });
  }
});

// ---------------------------------------------
// PROPOSAL REJECT (JWT-protected — replaces old trust-the-body version)
// ---------------------------------------------

app.patch(
  "/api/proposals/:id/reject",
  verifyJWT,
  requireRole(["client"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const client_email = req.user.email;

      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid proposal ID." });
      }

      const proposal = await proposalsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!proposal) {
        return res
          .status(404)
          .json({ success: false, message: "Proposal not found." });
      }

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

      await notificationsCollection.insertOne({
        user_email: proposal.freelancer_email,
        type: "proposal_rejected",
        task_id: proposal.task_id,
        task_title: task.title,
        message: `Your proposal for "${task.title}" was not accepted.`,
        is_read: false,
        created_at: new Date(),
      });

      res.status(200).json({ success: true, message: "Proposal rejected." });
    } catch (error) {
      console.error("PATCH /api/proposals/:id/reject error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to reject proposal." });
    }
  },
);

// ---------------------------------------------
// STRIPE CONFIRM SESSION (with notification side-effects)
// Intentionally NOT behind verifyJWT — this is reached via a top-level
// browser redirect from Stripe's hosted checkout, which carries no
// Authorization header. Security here relies on session_id being an
// opaque, unforgeable token issued by Stripe itself.
// ---------------------------------------------

app.get("/api/stripe/confirm-session", async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res
        .status(400)
        .json({ success: false, message: "session_id is required." });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res
        .status(400)
        .json({ success: false, message: "Payment has not been completed." });
    }

    const { proposal_id, task_id, client_email, freelancer_email } =
      session.metadata;

    const existingPayment = await paymentsCollection.findOne({
      transaction_id: session.payment_intent,
    });

    if (existingPayment) {
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

    const task = await tasksCollection.findOne({ _id: new ObjectId(task_id) });

    await proposalsCollection.updateOne(
      { _id: new ObjectId(proposal_id) },
      { $set: { status: "accepted" } },
    );

    const otherProposals = await proposalsCollection
      .find({ task_id, _id: { $ne: new ObjectId(proposal_id) } })
      .toArray();

    await proposalsCollection.updateMany(
      { task_id, _id: { $ne: new ObjectId(proposal_id) } },
      { $set: { status: "rejected" } },
    );

    await tasksCollection.updateOne(
      { _id: new ObjectId(task_id) },
      { $set: { status: "in-progress" } },
    );

    await paymentsCollection.insertOne({
      client_email,
      freelancer_email,
      task_id,
      amount: session.amount_total / 100,
      transaction_id: session.payment_intent,
      payment_status: "succeeded",
      paid_at: new Date(),
    });

    await notificationsCollection.insertOne({
      user_email: freelancer_email,
      type: "proposal_accepted",
      task_id,
      task_title: task?.title || "your task",
      message: `Your proposal for "${task?.title || "a task"}" was accepted! Payment received.`,
      is_read: false,
      created_at: new Date(),
    });

    if (otherProposals.length > 0) {
      await notificationsCollection.insertMany(
        otherProposals.map((p) => ({
          user_email: p.freelancer_email,
          type: "proposal_rejected",
          task_id,
          task_title: task?.title || "a task",
          message: `Your proposal for "${task?.title || "a task"}" was not accepted.`,
          is_read: false,
          created_at: new Date(),
        })),
      );
    }

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
    res
      .status(500)
      .json({ success: false, message: "Failed to confirm payment." });
  }
});

// ---------------------------------------------
// REVIEWS (registered at both endpoint names for literal spec compliance)
// ---------------------------------------------

async function createReview(req, res) {
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
}

app.post("/api/reviews", verifyJWT, requireRole(["freelancer"]), createReview);
app.post(
  "/api/reviews/client",
  verifyJWT,
  requireRole(["freelancer"]),
  createReview,
);

// ---------------------------------------------
// Root route
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
