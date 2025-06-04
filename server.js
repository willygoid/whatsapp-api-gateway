/*
    Whatsapp API Gateway
    @willygoid
    Ngawi, 4 Juni 2025
*/

import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import { createServer } from 'http';
import { Server } from 'socket.io';

// Convert ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create session directory if it doesn't exist
const SESSION_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR);
}

// Path for groups data
const GROUPS_FILE = path.join(__dirname, 'groups.json');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

// Global variables
let sock = null;
let qrText = null;
let isConnected = false;
let wa_state = null;
let groups = [];

// Load existing groups data if available
if (fs.existsSync(GROUPS_FILE)) {
  try {
    const data = fs.readFileSync(GROUPS_FILE, 'utf8');
    groups = JSON.parse(data);
    console.log(`Loaded ${groups.length} groups from file`);
  } catch (error) {
    console.error('Error loading groups file:', error);
    // Initialize with empty array if file is corrupted
    groups = [];
  }
} else {
  // Create empty groups file
  fs.writeFileSync(GROUPS_FILE, JSON.stringify([], null, 2));
}

// Function to save groups to file
function saveGroups() {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
  console.log(`Saved ${groups.length} groups to file`);
}

// Function to fetch and update groups
async function fetchGroups() {
  if (!sock || !isConnected) return;
  
  try {
    console.log('Fetching groups...');
    
    // Get all chats
    const chats = await sock.groupFetchAllParticipating();
    
    // Reset groups array
    groups = [];
    
    // Process each group
    for (const [id, chat] of Object.entries(chats)) {
      groups.push({
        id: id,
        name: chat.subject || 'Unknown Group',
        participants: chat.participants ? chat.participants.length : 0,
        creation: chat.creation || null
      });
    }
    
    // Save to file
    saveGroups();
    
    console.log(`Found ${groups.length} groups`);
  } catch (error) {
    console.error('Error fetching groups:', error);
  }
}

// Initialize WhatsApp connection
async function connectToWhatsApp() {
  // Create a new WhatsApp socket
  sock = makeWASocket({
    printQRInTerminal: true,
    auth: wa_state.state,
    browser: ['WhatsApp API', 'Chrome', '103.0.5060.114'],
  });
  
  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      // Generate QR code as text
      qrText = qr;
      console.log('QR Code generated. Scan to authenticate.');
      
      // Emit QR code to connected clients
      io.emit('qr', qr);
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      
      console.log('Connection closed due to ', lastDisconnect?.error?.message);
      isConnected = false;
      
      if (shouldReconnect) {
        console.log('Reconnecting...');
        connectToWhatsApp();
      } else {
        console.log('Disconnected permanently. Please restart the server.');
        io.emit('status', { connected: false, message: 'Disconnected permanently' });
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection established!');
      isConnected = true;
      qrText = null;
      io.emit('status', { connected: true, message: 'Connected' });
      
      // Fetch groups after successful connection
      setTimeout(fetchGroups, 2000); // Wait 2 seconds to ensure connection is stable
    }
  });
  
  // Listen for group updates
  sock.ev.on('groups.update', async (updates) => {
    console.log('Group update received:', updates);
    // Refresh groups after any update
    setTimeout(fetchGroups, 1000);
  });
  
  // Listen for new groups
  sock.ev.on('group-participants.update', async (update) => {
    console.log('Group participants update:', update);
    // Refresh groups when participants change
    setTimeout(fetchGroups, 1000);
  });
  
  // Save credentials whenever they are updated
  sock.ev.on('creds.update', wa_state.saveCreds);
  
  return sock;
}

async function startAuth(){
    wa_state = await useMultiFileAuthState('sessions');
    connectToWhatsApp();
}

// Start the connection
startAuth();

// API endpoint to get all groups
app.get('/groups', (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp is not connected. Please scan the QR code first.' 
    });
  }
  
  // Return the cached groups
  res.json({ 
    success: true, 
    groups: groups 
  });
});

// API endpoint to refresh groups
app.post('/refresh-groups', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp is not connected. Please scan the QR code first.' 
    });
  }
  
  try {
    await fetchGroups();
    res.json({ 
      success: true, 
      message: 'Groups refreshed successfully',
      groups: groups
    });
  } catch (error) {
    console.error('Error refreshing groups:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// API endpoint to send message to a contact
app.post('/send-to-contact', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ 
        success: false, 
        message: 'WhatsApp is not connected. Please scan the QR code first.' 
      });
    }
    
    const { phone, message, attachment } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number and message are required' 
      });
    }
    
    // Format the phone number (add country code if not present)
    let formattedPhone = phone.includes('@s.whatsapp.net') 
      ? phone 
      : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    
    // Send message
    if (attachment) {
      // Send message with attachment
      await sock.sendMessage(formattedPhone, {
        image: { url: attachment },
        caption: message
      });
    } else {
      // Send text message
      await sock.sendMessage(formattedPhone, { text: message });
    }
    
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// API endpoint to send message to a group
app.post('/send-to-group', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ 
        success: false, 
        message: 'WhatsApp is not connected. Please scan the QR code first.' 
      });
    }
    
    const { group, message, attachment } = req.body;
    
    if (!group || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Group ID and message are required' 
      });
    }
    
    // Format the group ID
    let formattedGroup = group.includes('@g.us') ? group : `${group}@g.us`;
    
    // Send message
    if (attachment) {
      // Send message with attachment
      await sock.sendMessage(formattedGroup, {
        image: { url: attachment },
        caption: message
      });
    } else {
      // Send text message
      await sock.sendMessage(formattedGroup, { text: message });
    }
    
    res.json({ success: true, message: 'Message sent to group successfully' });
  } catch (error) {
    console.error('Error sending message to group:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Unified endpoint that handles both contact and group messages
app.post('/send', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ 
        success: false, 
        message: 'WhatsApp is not connected. Please scan the QR code first.' 
      });
    }
    
    const { phone, group, message, attachment } = req.body;
    
    if ((!phone && !group) || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either phone number or group ID is required, along with a message' 
      });
    }
    
    let recipient;
    
    if (phone) {
      // Format the phone number
      recipient = phone.includes('@s.whatsapp.net') 
        ? phone 
        : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    } else {
      // Format the group ID
      recipient = group.includes('@g.us') ? group : `${group}@g.us`;
    }
    
    // Send message
    if (attachment) {
      // Send message with attachment
      await sock.sendMessage(recipient, {
        image: { url: attachment },
        caption: message
      });
    } else {
      // Send text message
      await sock.sendMessage(recipient, { text: message });
    }
    
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to get QR code as an image
app.get('/qr', async (req, res) => {
  if (!qrText) {
    return res.status(404).json({ success: false, message: 'QR code not available' });
  }
  
  try {
    const qrImage = await qrcode.toDataURL(qrText);
    res.type('html');
    res.send(`
      <html>
        <head>
          <title>WhatsApp QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            img { max-width: 300px; }
            .container { max-width: 500px; margin: 0 auto; }
            .status { margin-top: 20px; padding: 10px; border-radius: 5px; }
            .connected { background-color: #d4edda; color: #155724; }
            .disconnected { background-color: #f8d7da; color: #721c24; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Scan this QR Code</h1>
            <p>Open WhatsApp on your phone and scan this code to log in</p>
            <img src="${qrImage}" alt="WhatsApp QR Code">
            <div id="status" class="status disconnected">Waiting for scan...</div>
          </div>
          
          <script src="/socket.io/socket.io.js"></script>
          <script>
            const socket = io();
            const statusDiv = document.getElementById('status');
            
            socket.on('status', (data) => {
              if (data.connected) {
                statusDiv.className = 'status connected';
                statusDiv.textContent = 'Connected! You can now use the API.';
              } else {
                statusDiv.className = 'status disconnected';
                statusDiv.textContent = data.message || 'Disconnected';
              }
            });
            
            socket.on('qr', (data) => {
              location.reload(); // Reload to get the new QR code
            });
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({ 
    connected: isConnected,
    needsQR: !isConnected && qrText !== null
  });
});

// Simple HTML page to display status and QR code
app.get('/', (req, res) => {
  res.type('html');
  res.send(`
    <html>
      <head>
        <title>WhatsApp API</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
          .connected { background-color: #d4edda; color: #155724; }
          .disconnected { background-color: #f8d7da; color: #721c24; }
          .btn { display: inline-block; padding: 10px 20px; margin: 10px; 
                 background-color: #4CAF50; color: white; text-decoration: none; 
                 border-radius: 5px; }
          pre { background-color: #f5f5f5; padding: 15px; border-radius: 5px; 
                text-align: left; overflow: auto; }
          .group-list { text-align: left; margin-top: 20px; }
          .group-item { padding: 10px; border-bottom: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>WhatsApp API</h1>
          <div id="status" class="status disconnected">Checking status...</div>
          
          <div id="qrContainer" style="display: none;">
            <p>Scan this QR code with WhatsApp on your phone</p>
            <a href="/qr" class="btn">View QR Code</a>
          </div>
          
          <div id="apiInfo" style="display: none;">
            <h2>API Endpoints</h2>
            <p>Send message to a contact:</p>
            <pre>
POST /send-to-contact
{
  "phone": "1234567890",
  "message": "Hello world",
  "attachment": "https://example.com/image.jpg" (optional)
}</pre>
            
            <p>Send message to a group:</p>
            <pre>
POST /send-to-group
{
  "group": "group-id",
  "message": "Hello group",
  "attachment": "https://example.com/image.jpg" (optional)
}</pre>

            <p>Unified endpoint:</p>
            <pre>
POST /send
{
  "phone": "1234567890", // OR "group": "group-id"
  "message": "Hello",
  "attachment": "https://example.com/image.jpg" (optional)
}</pre>

            <h2>Groups</h2>
            <button id="refreshGroups" class="btn">Refresh Groups</button>
            <div id="groupList" class="group-list">Loading groups...</div>
          </div>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const statusDiv = document.getElementById('status');
          const qrContainer = document.getElementById('qrContainer');
          const apiInfo = document.getElementById('apiInfo');
          const groupList = document.getElementById('groupList');
          const refreshGroupsBtn = document.getElementById('refreshGroups');
          
          // Check initial status
          fetch('/status')
            .then(res => res.json())
            .then(data => {
              updateStatus(data);
            });
          
          function updateStatus(data) {
            if (data.connected) {
              statusDiv.className = 'status connected';
              statusDiv.textContent = 'Connected to WhatsApp';
              qrContainer.style.display = 'none';
              apiInfo.style.display = 'block';
              loadGroups();
            } else {
              statusDiv.className = 'status disconnected';
              statusDiv.textContent = 'Not connected to WhatsApp';
              qrContainer.style.display = 'block';
              apiInfo.style.display = 'none';
            }
          }
          
          function loadGroups() {
            fetch('/groups')
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  displayGroups(data.groups);
                } else {
                  groupList.innerHTML = '<p>Error loading groups: ' + data.message + '</p>';
                }
              })
              .catch(err => {
                groupList.innerHTML = '<p>Error loading groups: ' + err.message + '</p>';
              });
          }
          
          function displayGroups(groups) {
            if (groups.length === 0) {
              groupList.innerHTML = '<p>No groups found</p>';
              return;
            }
            
            let html = '';
            groups.forEach(group => {
              html += '<div class="group-item">';
              html += '<strong>' + escapeHtml(group.name) + '</strong><br>';
              html += 'ID: <code>' + escapeHtml(group.id) + '</code><br>';
              html += 'Participants: ' + group.participants;
              html += '</div>';
            });
            
            groupList.innerHTML = html;
          }
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          refreshGroupsBtn.addEventListener('click', () => {
            groupList.innerHTML = 'Refreshing groups...';
            fetch('/refresh-groups', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  displayGroups(data.groups);
                } else {
                  groupList.innerHTML = '<p>Error refreshing groups: ' + data.message + '</p>';
                }
              })
              .catch(err => {
                groupList.innerHTML = '<p>Error refreshing groups: ' + err.message + '</p>';
              });
          });
          
          socket.on('status', updateStatus);
          
          socket.on('qr', (data) => {
            statusDiv.textContent = 'New QR Code available. Please scan.';
          });
        </script>
      </body>
    </html>
  `);
});

// Start the server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`- Access the web interface at http://localhost:${PORT}`);
  console.log(`- QR code available at http://localhost:${PORT}/qr when needed`);
});
