const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// ✅ Enable trust proxy for rate limiting behind proxies
app.set('trust proxy', 1);

// Configuration
const SHARE_RATE = 10;
const RATE_INTERVAL = 2000;
const MAX_LIMIT = 1000;

// API Configuration
const PRIMARY_API = "https://shir-api.onrender.com/api/shirr";
const FALLBACK_API = "https://vern-rest-api.vercel.app/api/share";

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: '*',
  credentials: true
}));

// Rate limiter for API endpoints
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5000,
  message: { status: false, message: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress;
  }
});

app.use('/api/', limiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// User Agents pool (for potential future use)
const ua_list = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

// Store active shares
let shareHistory = [];
let activeShares = new Map();

// Load history
(async () => {
  try {
    const data = await fs.readFile('./history.json', 'utf8');
    shareHistory = JSON.parse(data);
  } catch (err) {
    shareHistory = [];
  }
})();

// Save history periodically
setInterval(async () => {
  try {
    await fs.writeFile('./history.json', JSON.stringify(shareHistory, null, 2));
  } catch (err) {
    console.error('Error saving history:', err);
  }
}, 60000);

// Main share function with new primary API and fallback
async function performShare(post_link, cookie, shareId, totalLimit, updateCallback) {
  const results = [];
  
  // Primary API call function (SHIR API)
  const primaryShareFn = async () => {
    try {
      // URL encode the cookie for GET request
      const encodedCookie = encodeURIComponent(cookie);
      const url = `${PRIMARY_API}?cookie=${encodedCookie}&link=${encodeURIComponent(post_link)}&limit=1`;
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      
      if (response.data && response.data.status === true) {
        return { success: true, id: Date.now().toString() };
      }
      return { success: false, error: response.data.message || 'Primary API failed' };
    } catch (err) {
      console.error('Primary API error:', err.message);
      return { success: false, error: err.message };
    }
  };

  // Fallback API call function (Vern API)
  const fallbackShareFn = async () => {
    try {
      const response = await axios.get(FALLBACK_API, {
        params: {
          cookie: cookie,
          link: post_link,
          limit: 1
        },
        timeout: 15000
      });
      
      if (response.data && response.data.status === true) {
        return { success: true, id: Date.now().toString() };
      }
      return { success: false, error: response.data.message || 'Fallback API failed' };
    } catch (err) {
      console.error('Fallback API error:', err.message);
      return { success: false, error: err.message };
    }
  };

  let primaryFailCount = 0;
  let useFallback = false;

  for (let i = 0; i < totalLimit; i++) {
    if (activeShares.get(shareId) === 'cancelled') {
      break;
    }

    try {
      let result;
      
      if (!useFallback) {
        result = await primaryShareFn();
        if (!result.success) {
          primaryFailCount++;
          if (primaryFailCount >= 2) {  // Switch to fallback after 2 failures
            useFallback = true;
            console.log('⚠️ Switching to fallback API due to primary API failures');
            result = await fallbackShareFn();
          }
        }
      } else {
        result = await fallbackShareFn();
      }
      
      results.push(result);
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      if (updateCallback) {
        updateCallback({
          completed: i + 1,
          success: successCount,
          failed: failedCount,
          progress: Math.round(((i + 1) / totalLimit) * 100),
          usingFallback: useFallback
        });
      }
      
      // Small delay between requests to be respectful
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (err) {
      results.push({ success: false, error: err.message });
      if (updateCallback) {
        updateCallback({
          completed: i + 1,
          success: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          progress: Math.round(((i + 1) / totalLimit) * 100)
        });
      }
    }
  }

  return {
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    total: results.length,
    usedFallback: useFallback
  };
}

// ============= UI ROUTES =============
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("/share", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get("/api-docs", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
});

// ============= API ROUTES =============

// Start sharing - POST method
app.post("/api/share", async (req, res) => {
  const shareId = Date.now().toString();

  try {
    const { cookie, link: post_link, limit } = req.body;
    const limitNum = parseInt(limit, 10);

    if (!cookie || !post_link || !limitNum) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields: cookie, link, and limit are required."
      });
    }

    if (limitNum < 1 || limitNum > MAX_LIMIT) {
      return res.status(400).json({
        status: false,
        message: `Limit must be between 1 and ${MAX_LIMIT} shares.`
      });
    }

    try {
      new URL(post_link);
    } catch {
      return res.status(400).json({
        status: false,
        message: "Invalid URL format."
      });
    }

    // Send immediate response
    res.json({
      status: 'processing',
      message: 'Starting share process...',
      share_id: shareId
    });

    // Create history entry
    const historyEntry = {
      id: shareId,
      link: post_link,
      requested: limitNum,
      success: 0,
      failed: 0,
      status: 'processing',
      progress: 0,
      startTime: new Date(),
      endTime: null
    };

    shareHistory.push(historyEntry);
    activeShares.set(shareId, 'active');

    const updateCallback = (update) => {
      const entry = shareHistory.find(h => h.id === shareId);
      if (entry) {
        entry.success = update.success;
        entry.failed = update.failed;
        entry.progress = update.progress;
      }
    };

    const shareResults = await performShare(
      post_link, cookie, shareId, limitNum, updateCallback
    );

    const finalEntry = shareHistory.find(h => h.id === shareId);
    if (finalEntry) {
      finalEntry.status = shareResults.success > 0 ? 'completed' : 'failed';
      finalEntry.endTime = new Date();
      finalEntry.success = shareResults.success;
      finalEntry.failed = shareResults.failed;
      finalEntry.progress = 100;
    }

    activeShares.delete(shareId);

    // Keep last 200 entries
    if (shareHistory.length > 200) {
      shareHistory = shareHistory.slice(-200);
    }

  } catch (error) {
    console.error('API Error:', error);
    activeShares.delete(shareId);
  }
});

// Get share progress
app.get("/api/share/:id/progress", (req, res) => {
  const shareId = req.params.id;
  const share = shareHistory.find(h => h.id === shareId);

  if (!share) {
    return res.status(404).json({
      status: false,
      message: 'Share not found'
    });
  }

  res.json({
    status: true,
    share: {
      id: share.id,
      progress: share.progress || 0,
      success: share.success || 0,
      failed: share.failed || 0,
      requested: share.requested,
      status: share.status,
      active: activeShares.has(shareId),
      startTime: share.startTime,
      endTime: share.endTime
    }
  });
});

// Cancel share
app.post("/api/share/:id/cancel", (req, res) => {
  const shareId = req.params.id;

  if (activeShares.has(shareId)) {
    activeShares.set(shareId, 'cancelled');
    
    const share = shareHistory.find(h => h.id === shareId);
    if (share) {
      share.status = 'cancelled';
      share.endTime = new Date();
    }

    res.json({
      status: true,
      message: 'Share cancelled successfully'
    });
  } else {
    res.status(404).json({
      status: false,
      message: 'No active share found with that ID'
    });
  }
});

// Share history
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    status: true,
    history: shareHistory.slice(-limit).reverse()
  });
});

// Running shares
app.get("/api/running-shares", (req, res) => {
  const runningShares = shareHistory.filter(item => 
    item.status === 'processing' && activeShares.has(item.id)
  );
  res.json({
    status: true,
    running_shares: runningShares
  });
});

// Stats
app.get("/api/stats", (req, res) => {
  const totalShares = shareHistory.length;
  const totalSuccess = shareHistory.reduce((acc, curr) => acc + (curr.success || 0), 0);
  const totalFailed = shareHistory.reduce((acc, curr) => acc + (curr.failed || 0), 0);
  const completedShares = shareHistory.filter(s => s.status === 'completed').length;
  
  const successRate = totalShares > 0 
    ? Math.round((completedShares / totalShares) * 100) 
    : 0;

  res.json({
    status: true,
    stats: {
      total_shares: totalShares,
      total_successful_shares: totalSuccess,
      total_failed_shares: totalFailed,
      completed_shares: completedShares,
      success_rate: successRate,
      active_shares: activeShares.size,
      max_limit: MAX_LIMIT,
      primary_api: PRIMARY_API,
      fallback_api: FALLBACK_API
    }
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    active_shares: activeShares.size
  });
});

// TikTok video endpoint
app.get("/api/tiktok-video", async (req, res) => {
  const API_URL = "https://betadash-shoti-yazky.vercel.app/shotizxx?apikey=shipazu";

  try {
    const response = await axios.get(API_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.shotiurl) {
      res.json({
        status: true,
        video: {
          url: response.data.shotiurl,
          cover: response.data.cover_image || response.data.cover,
          author: response.data.author || response.data.username,
          nickname: response.data.nickname || response.data.author,
          title: response.data.title || "TikTok Video",
          duration: response.data.duration || 0,
          region: response.data.region || "PH"
        }
      });
    } else {
      throw new Error('Invalid response');
    }
  } catch (error) {
    console.error('TikTok API Error:', error.message);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch video. Please try again.'
    });
  }
});

// ============= ERROR PAGES =============

// 404 Error page
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// 500 Error page
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📈 Max limit: ${MAX_LIMIT} shares per campaign`);
  console.log(`🎯 Primary API: ${PRIMARY_API}`);
  console.log(`🔄 Fallback API: ${FALLBACK_API}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 API Docs: http://localhost:${PORT}/api-docs`);
});