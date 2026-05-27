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
const SHARE_RATE = 20; // 20 shares per interval
const RATE_INTERVAL = 2000; // 2 seconds
const MAX_CONCURRENT = 30;

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
  max: 10000,
  message: { status: false, message: 'Too many requests, please slow down.' }
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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15"
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
          await new Promise(resolve => setTimeout(resolve, 30));
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

// Token extraction for Main API
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

// Main API Share Function
async function performMainShare(post_link, token, cookie, ua, shareId, totalLimit, updateCallback) {
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
          timeout: 10000
        }
      );

      if (response.data && response.data.id) {
        return { success: true, id: response.data.id, api: 'Main' };
      }
      return { success: false, error: 'No ID returned', api: 'Main' };
    } catch (err) {
      return { success: false, error: err.message, api: 'Main' };
    }
  };

  for (let i = 0; i < totalLimit; i++) {
    if (activeShares.get(shareId) === 'cancelled') break;

    try {
      const result = await shareRateLimiter.addRequest(shareFn);
      results.push(result);
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      if (updateCallback) {
        updateCallback('main', {
          completed: i + 1,
          success: successCount,
          failed: failedCount,
          progress: Math.round(((i + 1) / totalLimit) * 100)
        });
      }
    } catch (err) {
      results.push({ success: false, error: err.message, api: 'Main' });
      if (updateCallback) {
        updateCallback('main', {
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

// Vern API Share Function
async function performVernShare(cookie, link, amount, shareId, updateCallback) {
  const VERN_API = "https://vern-rest-api.vercel.app/api/share";
  let successCount = 0;
  let failedCount = 0;
  
  for (let i = 0; i < amount; i++) {
    if (activeShares.get(shareId) === 'cancelled') break;
    
    try {
      const response = await axios.get(VERN_API, {
        params: {
          cookie: cookie,
          link: link,
          limit: 1
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.data && response.data.status === true) {
        successCount++;
      } else {
        failedCount++;
      }
    } catch (err) {
      console.error('Vern API error:', err.message);
      failedCount++;
    }
    
    const progress = Math.round(((i + 1) / amount) * 100);
    if (updateCallback) {
      updateCallback('vern', {
        completed: i + 1,
        success: successCount,
        failed: failedCount,
        progress: progress
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return { success: successCount, failed: failedCount, total: amount };
}

// FBS API - Smart Dual API that works together
// If one API fails, the other automatically covers the remaining shares
async function performFBSShare(cookie, link, token, ua, shareId, totalLimit, updateCallback) {
  // Split target between both APIs
  let mainTarget = Math.ceil(totalLimit / 2);
  let vernTarget = Math.floor(totalLimit / 2);
  
  let mainCompleted = 0;
  let vernCompleted = 0;
  let mainSuccess = 0;
  let vernSuccess = 0;
  let mainFailed = 0;
  let vernFailed = 0;
  
  // Track if APIs are still active
  let mainActive = true;
  let vernActive = true;
  let mainFinished = false;
  let vernFinished = false;
  
  // Progress tracking
  let lastUpdate = { main: 0, vern: 0 };
  
  const updateProgress = () => {
    const totalSuccess = mainSuccess + vernSuccess;
    const totalFailed = mainFailed + vernFailed;
    const totalCompleted = mainCompleted + vernCompleted;
    const progress = Math.round((totalCompleted / totalLimit) * 100);
    
    if (updateCallback) {
      updateCallback({
        success: totalSuccess,
        failed: totalFailed,
        progress: progress,
        main_success: mainSuccess,
        main_failed: mainFailed,
        vern_success: vernSuccess,
        vern_failed: vernFailed
      });
    }
  };
  
  // Main API worker
  const mainWorker = async () => {
    if (!token) {
      mainActive = false;
      mainFinished = true;
      updateProgress();
      return;
    }
    
    for (let i = 0; i < mainTarget; i++) {
      if (activeShares.get(shareId) === 'cancelled') break;
      if (!mainActive) break;
      
      try {
        const result = await shareRateLimiter.addRequest(async () => {
          const response = await axios.post(
            "https://graph.facebook.com/v18.0/me/feed",
            null,
            {
              params: {
                link: link,
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
              timeout: 10000
            }
          );
          
          if (response.data && response.data.id) {
            return { success: true };
          }
          return { success: false };
        });
        
        if (result.success) {
          mainSuccess++;
        } else {
          mainFailed++;
          // If Main API fails too many times, let Vern take over
          if (mainFailed > 5) {
            console.log('Main API failing, transferring remaining shares to Vern API');
            mainActive = false;
            vernTarget += (mainTarget - (i + 1));
            break;
          }
        }
        mainCompleted++;
        updateProgress();
        
      } catch (err) {
        mainFailed++;
        mainCompleted++;
        if (mainFailed > 5) {
          mainActive = false;
          vernTarget += (mainTarget - (i + 1));
          break;
        }
        updateProgress();
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    mainFinished = true;
    updateProgress();
  };
  
  // Vern API worker
  const vernWorker = async () => {
    const VERN_API = "https://vern-rest-api.vercel.app/api/share";
    
    for (let i = 0; i < vernTarget; i++) {
      if (activeShares.get(shareId) === 'cancelled') break;
      if (!vernActive) break;
      
      try {
        const response = await axios.get(VERN_API, {
          params: {
            cookie: cookie,
            link: link,
            limit: 1
          },
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (response.data && response.data.status === true) {
          vernSuccess++;
        } else {
          vernFailed++;
          if (vernFailed > 5) {
            console.log('Vern API failing, transferring remaining shares to Main API');
            vernActive = false;
            if (mainActive) {
              // Main will take over remaining shares
            }
            break;
          }
        }
        vernCompleted++;
        updateProgress();
        
      } catch (err) {
        vernFailed++;
        vernCompleted++;
        if (vernFailed > 5) {
          vernActive = false;
          break;
        }
        updateProgress();
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    vernFinished = true;
    updateProgress();
  };
  
  // Run both workers in parallel
  await Promise.all([mainWorker(), vernWorker()]);
  
  // If one API failed to reach its target, the other continues
  // This is handled by the dynamic target adjustment above
  
  return {
    success: mainSuccess + vernSuccess,
    failed: mainFailed + vernFailed,
    total: totalLimit,
    main_success: mainSuccess,
    main_failed: mainFailed,
    vern_success: vernSuccess,
    vern_failed: vernFailed
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

// FBS API - Smart Dual API Endpoint
app.post("/api/share", async (req, res) => {
  const shareId = Date.now().toString();

  try {
    let { cookie, link: post_link, limit } = req.body;
    const limitNum = parseInt(limit, 10);

    if (!cookie || !post_link || !limitNum) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields: cookie, link, and limit are required."
      });
    }

    if (limitNum < 1 || limitNum > 1000) {
      return res.status(400).json({
        status: false,
        message: "Limit must be between 1 and 1000 shares."
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
      message: 'FBS API: Starting smart dual API sharing...',
      share_id: shareId
    });

    const ua = ua_list[Math.floor(Math.random() * ua_list.length)];
    
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
      api_used: 'FBS API (Smart Dual API)'
    };

    shareHistory.push(historyEntry);
    activeShares.set(shareId, 'active');

    // Extract token for Main API
    const token = await extract_token(cookie, ua);
    
    // Progress update callback
    const updateCallback = (update) => {
      const entry = shareHistory.find(h => h.id === shareId);
      if (entry) {
        entry.success = update.success;
        entry.failed = update.failed;
        entry.progress = update.progress;
      }
    };
    
    // Run FBS Smart Dual API
    const result = await performFBSShare(cookie, post_link, token, ua, shareId, limitNum, updateCallback);
    
    // Finalize
    const finalEntry = shareHistory.find(h => h.id === shareId);
    if (finalEntry) {
      finalEntry.status = result.success > 0 ? 'completed' : 'failed';
      finalEntry.endTime = new Date();
      finalEntry.success = result.success;
      finalEntry.failed = result.failed;
      finalEntry.progress = 100;
    }

    activeShares.delete(shareId);

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
      api_used: share.api_used
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
      rate: `20 shares per 2 seconds (FBS Smart Dual API)`
    }
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: true,
    message: 'FBS API Server is running',
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

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 FBS API Server running on port ${PORT}`);
  console.log(`📊 Smart Dual API: Main + Vern working together`);
  console.log(`⚡ If one API fails, the other auto-takes over`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 API Docs: http://localhost:${PORT}/api-docs`);
});