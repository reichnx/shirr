const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// Configuration
const SHARE_RATE = 10; // 10 shares per second
const RATE_INTERVAL = 1000; // 1 second interval
const MAX_SHARE_LIMIT = 10000; // 10k max limit

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5000,
  message: { status: false, message: 'Too many requests, please wait a moment.' }
});

app.use('/api/', limiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// User Agents pool
const ua_list = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
];

// Store active shares
let shareHistory = [];
let activeShares = new Map();
let savedCookies = []; // Store multiple cookies

// Load data
(async () => {
  try {
    const data = await fs.readFile('./history.json', 'utf8');
    shareHistory = JSON.parse(data);
  } catch (err) {
    shareHistory = [];
  }
  try {
    const cookieData = await fs.readFile('./cookies.json', 'utf8');
    savedCookies = JSON.parse(cookieData);
  } catch (err) {
    savedCookies = [];
  }
})();

// Save data periodically
setInterval(async () => {
  try {
    await fs.writeFile('./history.json', JSON.stringify(shareHistory, null, 2));
    await fs.writeFile('./cookies.json', JSON.stringify(savedCookies, null, 2));
  } catch (err) {
    console.error('Error saving data:', err);
  }
}, 60000);

// Rate limiter for shares
class ShareRateLimiter {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.requestCount = 0;
    this.lastReset = Date.now();
  }

  async addRequest(shareFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ shareFn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      
      if (now - this.lastReset >= RATE_INTERVAL) {
        this.requestCount = 0;
        this.lastReset = now;
      }

      if (this.requestCount < SHARE_RATE) {
        const { shareFn, resolve, reject } = this.queue.shift();
        this.requestCount++;
        
        try {
          const result = await shareFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
        
        if (this.requestCount < SHARE_RATE) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } else {
        const waitTime = RATE_INTERVAL - (now - this.lastReset);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    this.processing = false;
  }
}

const shareRateLimiter = new ShareRateLimiter();

// Token extraction
async function extract_token(cookie, ua) {
  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios.get(
        "https://business.facebook.com/business_locations",
        {
          headers: {
            "user-agent": ua,
            "cookie": cookie,
            "referer": "https://www.facebook.com/",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br",
            "connection": "keep-alive"
          },
          timeout: 15000,
          maxRedirects: 5
        }
      );

      const patterns = [
        /(EAAG\w+)/,
        /(EAA[A-Za-z0-9]+)/,
        /access_token=([^&\s"]+)/
      ];

      for (const pattern of patterns) {
        const match = response.data.match(pattern);
        if (match) return match[1];
      }

      return null;
    } catch (err) {
      if (i === 2) return null;
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
}

// Share with single cookie
async function shareWithCookie(post_link, cookie, shareId, totalLimit, updateCallback) {
  const ua = ua_list[Math.floor(Math.random() * ua_list.length)];
  const token = await extract_token(cookie, ua);
  
  if (!token) {
    return { success: 0, failed: totalLimit, error: 'Token extraction failed' };
  }

  const results = [];
  const shareFn = async () => {
    try {
      const response = await axios.post(
        "https://graph.facebook.com/v18.0/me/feed",
        null,
        {
          params: {
            link: post_link,
            access_token: token,
            published: 0
          },
          headers: {
            "user-agent": ua,
            "cookie": cookie,
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/x-www-form-urlencoded",
            "origin": "https://business.facebook.com",
            "referer": "https://business.facebook.com/"
          },
          timeout: 15000
        }
      );

      if (response.data && response.data.id) {
        return { success: true, id: response.data.id };
      }
      return { success: false, error: 'No ID returned' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  for (let i = 0; i < totalLimit; i++) {
    if (activeShares.get(shareId) === 'cancelled') {
      break;
    }

    try {
      const result = await shareRateLimiter.addRequest(shareFn);
      results.push(result);
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      if (updateCallback) {
        updateCallback({
          completed: i + 1,
          success: successCount,
          failed: failedCount,
          progress: Math.round(((i + 1) / totalLimit) * 100)
        });
      }
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
    total: results.length
  };
}

// Share with multiple cookies (round-robin)
async function shareWithMultipleCookies(post_link, cookies, shareId, totalLimit, updateCallback) {
  const results = [];
  let currentCookieIndex = 0;
  const sharesPerCookie = Math.ceil(totalLimit / cookies.length);
  
  for (let i = 0; i < cookies.length; i++) {
    if (activeShares.get(shareId) === 'cancelled') break;
    
    const cookie = cookies[i];
    const remaining = totalLimit - results.length;
    const limit = Math.min(sharesPerCookie, remaining);
    
    if (limit <= 0) break;
    
    const cookieResult = await shareWithCookie(post_link, cookie, shareId, limit, (update) => {
      const totalSuccess = results.filter(r => r.success).length + update.success;
      const totalFailed = results.filter(r => !r.success).length + update.failed;
      const totalCompleted = results.length + update.completed;
      
      if (updateCallback) {
        updateCallback({
          completed: totalCompleted,
          success: totalSuccess,
          failed: totalFailed,
          progress: Math.round((totalCompleted / totalLimit) * 100)
        });
      }
    });
    
    results.push(...cookieResult.results || []);
  }
  
  return {
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    total: results.length
  };
}

// ============= API ROUTES =============

// TikTok Video API
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

// Save multiple cookies
app.post("/api/cookies/save", (req, res) => {
  const { cookies } = req.body;
  
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({
      status: false,
      message: 'Please provide an array of cookies'
    });
  }
  
  savedCookies = cookies;
  res.json({
    status: true,
    message: `${cookies.length} cookies saved successfully`,
    cookies: savedCookies.map((c, i) => ({ index: i + 1, preview: c.substring(0, 30) + '...' }))
  });
});

// Get saved cookies
app.get("/api/cookies", (req, res) => {
  res.json({
    status: true,
    cookies: savedCookies.map((c, i) => ({ index: i + 1, preview: c.substring(0, 30) + '...' })),
    total: savedCookies.length
  });
});

// Add single cookie
app.post("/api/cookies/add", (req, res) => {
  const { cookie } = req.body;
  
  if (!cookie) {
    return res.status(400).json({
      status: false,
      message: 'Please provide a cookie'
    });
  }
  
  savedCookies.push(cookie);
  res.json({
    status: true,
    message: 'Cookie added successfully',
    total: savedCookies.length
  });
});

// Remove cookie
app.delete("/api/cookies/remove/:index", (req, res) => {
  const index = parseInt(req.params.index);
  
  if (index >= 0 && index < savedCookies.length) {
    savedCookies.splice(index, 1);
    res.json({
      status: true,
      message: 'Cookie removed successfully',
      total: savedCookies.length
    });
  } else {
    res.status(404).json({
      status: false,
      message: 'Cookie not found'
    });
  }
});

// Start sharing (supports single or multiple cookies)
app.post("/api/share", async (req, res) => {
  const shareId = Date.now().toString();

  try {
    let { cookies, link: post_link, limit, useMultipleCookies } = req.body;
    const limitNum = parseInt(limit, 10);

    if ((!cookies || cookies.length === 0) && savedCookies.length === 0) {
      return res.status(400).json({
        status: false,
        message: "Please provide at least one cookie"
      });
    }

    if (!post_link || !limitNum) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields: link and limit are required."
      });
    }

    if (limitNum < 1 || limitNum > MAX_SHARE_LIMIT) {
      return res.status(400).json({
        status: false,
        message: `Limit must be between 1 and ${MAX_SHARE_LIMIT} shares.`
      });
    }

    // Use cookies from request or saved cookies
    let activeCookies = cookies && cookies.length > 0 ? cookies : savedCookies;
    
    if (useMultipleCookies && activeCookies.length > 1) {
      // Use multiple cookies for round-robin sharing
      res.json({
        status: 'processing',
        message: `Starting share process with ${activeCookies.length} cookies...`,
        share_id: shareId,
        mode: 'multi-cookie'
      });
    } else {
      // Use single cookie (first one)
      activeCookies = [activeCookies[0]];
      res.json({
        status: 'processing',
        message: 'Starting share process with single cookie...',
        share_id: shareId,
        mode: 'single-cookie'
      });
    }

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
      endTime: null,
      cookiesUsed: activeCookies.length,
      mode: activeCookies.length > 1 ? 'multi-cookie' : 'single-cookie'
    };

    shareHistory.push(historyEntry);
    activeShares.set(shareId, 'active');

    // Perform sharing
    const updateCallback = (update) => {
      const entry = shareHistory.find(h => h.id === shareId);
      if (entry) {
        entry.success = update.success;
        entry.failed = update.failed;
        entry.progress = update.progress;
      }
    };

    let shareResults;
    if (activeCookies.length > 1) {
      shareResults = await shareWithMultipleCookies(post_link, activeCookies, shareId, limitNum, updateCallback);
    } else {
      shareResults = await shareWithCookie(post_link, activeCookies[0], shareId, limitNum, updateCallback);
    }

    // Finalize
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
      endTime: share.endTime,
      mode: share.mode,
      cookiesUsed: share.cookiesUsed
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
      saved_cookies: savedCookies.length,
      max_limit: MAX_SHARE_LIMIT
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
    active_shares: activeShares.size,
    saved_cookies: savedCookies.length
  });
});

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

// ============= ERROR PAGES =============

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Max share limit: ${MAX_SHARE_LIMIT} shares`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 API Docs: http://localhost:${PORT}/api-docs`);
  console.log(`🍪 Multi-cookie support: ENABLED`);
});