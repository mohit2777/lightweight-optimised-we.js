// Simple test file to verify the setup
require('dotenv').config();

console.log('Testing WhatsApp Multi-Automation V2 Configuration...\n');

// Check environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DASHBOARD_USERNAME',
  'DASHBOARD_PASSWORD',
  'SESSION_SECRET'
];

console.log('Checking required environment variables:');
let allPresent = true;

requiredEnvVars.forEach(varName => {
  const isPresent = !!process.env[varName];
  console.log(`  ${varName}: ${isPresent ? '✓ Present' : '✗ Missing'}`);
  if (!isPresent) allPresent = false;
});

if (allPresent) {
  console.log('\n✓ All required environment variables are set!');
} else {
  console.log('\n✗ Some environment variables are missing. Please check your .env file.');
  process.exit(1);
}

// Check dependencies
console.log('\nChecking dependencies:');
const dependencies = [
  'express',
  'whatsapp-web.js',
  '@supabase/supabase-js',
  'socket.io',
  'dotenv'
];

dependencies.forEach(dep => {
  try {
    require(dep);
    console.log(`  ${dep}: ✓ Installed`);
  } catch (e) {
    console.log(`  ${dep}: ✗ Not installed`);
    allPresent = false;
  }
});

if (allPresent) {
  console.log('\n✓ All dependencies are installed!');
  console.log('\nYou can now run the application with:');
  console.log('  npm start     (production)');
  console.log('  npm run dev   (development)');
} else {
  console.log('\n✗ Some dependencies are missing. Run: npm install');
  process.exit(1);
}
