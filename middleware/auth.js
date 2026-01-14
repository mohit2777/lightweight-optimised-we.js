const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
require('dotenv').config();

// Middleware to check if user is authenticated
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    // Update last activity
    req.session.lastActivity = Date.now();
    return next();
  }
  
  // For API routes, return JSON error (use originalUrl to get full path including mount point)
  if (req.originalUrl.startsWith('/api/')) {
    logger.warn(`Unauthorized API access attempt: ${req.method} ${req.originalUrl} from ${req.ip}`);
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please login to access this resource'
    });
  }
  
  // For web routes, redirect to login
  res.redirect('/login');
};

// Middleware to check if user is not authenticated (for login page)
const requireGuest = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  next();
};

// Session timeout middleware - DISABLED (no limit)
const checkSessionTimeout = (req, res, next) => {
  // Session timeout removed - sessions never expire automatically
  if (req.session && req.session.authenticated) {
    req.session.lastActivity = Date.now();
  }
  next();
};

// Login handler with improved security
const login = async (req, res) => {
  const { username, password } = req.body;
  
  const expectedUsername = process.env.DASHBOARD_USERNAME || 'admin';
  const expectedPassword = process.env.DASHBOARD_PASSWORD || 'admin123';
  
  try {
    // Check username
    if (username !== expectedUsername) {
      logger.warn(`Failed login attempt for username: ${username} from IP: ${req.ip}`);
      return res.status(401).json({ 
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }
    
    // Verify password using bcrypt for timing-attack resistance
    // We hash the expected password and compare (note: in production, store pre-hashed passwords)
    const expectedHash = bcrypt.hashSync(expectedPassword, 10);
    const isValid = await bcrypt.compare(password, expectedHash);
    
    if (isValid) {
      // Set session data
      req.session.authenticated = true;
      req.session.username = username;
      req.session.loginTime = Date.now();
      req.session.lastActivity = Date.now();
      req.session.ip = req.ip;
      req.session.userAgent = req.headers['user-agent'];
      
      logger.info(`Successful login for user: ${username} from IP: ${req.ip}`);
      
      return res.json({ 
        success: true, 
        message: 'Login successful',
        redirect: '/dashboard',
        user: {
          username: username,
          loginTime: req.session.loginTime
        }
      });
    } else {
      logger.warn(`Failed login attempt for username: ${username} from IP: ${req.ip}`);
      return res.status(401).json({ 
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({ 
      error: 'Login failed',
      message: 'An error occurred during login'
    });
  }
};

// Logout handler
const logout = (req, res) => {
  const username = req.session?.username;
  
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ 
        error: 'Logout failed',
        message: 'An error occurred during logout'
      });
    }
    
    logger.info(`User logged out: ${username}`);
    
    res.json({ 
      success: true, 
      message: 'Logout successful',
      redirect: '/login'
    });
  });
};

// Get current user info
const getCurrentUser = (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({
      authenticated: true,
      username: req.session.username,
      loginTime: req.session.loginTime,
      lastActivity: req.session.lastActivity
    });
  }
  
  res.json({ authenticated: false });
};

// Verify session integrity
const verifySessionIntegrity = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    // Check if IP changed (optional - may cause issues with mobile networks)
    // if (req.session.ip !== req.ip) {
    //   logger.warn(`Session IP mismatch for user: ${req.session.username}`);
    //   req.session.destroy();
    //   return res.status(401).json({ error: 'Session invalid' });
    // }
    
    // Check if user agent changed
    if (req.session.userAgent !== req.headers['user-agent']) {
      logger.warn(`Session user-agent mismatch for user: ${req.session.username}`);
      req.session.destroy();
      
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ 
          error: 'Session invalid',
          message: 'Your session has been invalidated for security reasons.'
        });
      }
      
      return res.redirect('/login');
    }
  }
  
  next();
};

module.exports = {
  requireAuth,
  requireGuest,
  checkSessionTimeout,
  login,
  logout,
  getCurrentUser,
  verifySessionIntegrity
};
