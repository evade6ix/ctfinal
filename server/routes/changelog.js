// server/routes/changelog.js
import express from "express";
import { ChangeLog } from "../models/ChangeLog.js";

const router = express.Router();

/**
 * GET /api/changelog
 * ?page=1&limit=50
 */
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "50", 10);

    const [logs, total] = await Promise.all([
      ChangeLog.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ChangeLog.countDocuments(),
    ]);

    res.json({
      logs,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Error fetching changelog:", err);
    res.status(500).json({ error: "Failed to fetch changelog" });
  }
});

export default router;
