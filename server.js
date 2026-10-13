const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// -------------------------------------------------------------
// Middlewares
// -------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve frontend static files
app.use(express.static(__dirname));

// Admin Authentication Middleware (Check x-admin-password header)
const verifyAdmin = (req, res, next) => {
  const password = req.headers['x-admin-password'];
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: 'รหัสผ่านแอดมินไม่ถูกต้อง หรือไม่มีสิทธิ์เข้าถึง (Unauthorized)'
    });
  }
  next();
};

// -------------------------------------------------------------
// MongoDB Schema & Model Definition
// -------------------------------------------------------------
const ItemSchema = new mongoose.Schema({
  reportType: {
    type: String,
    enum: ['LOST', 'FOUND'],
    required: [true, 'Report type is required']
  },
  itemName: {
    type: String,
    required: [true, 'Item name is required'],
    trim: true
  },
  category: {
    type: String,
    required: [true, 'Category is required']
  },
  location: {
    type: String,
    required: [true, 'Location is required'],
    trim: true
  },
  dateTime: {
    type: Date,
    required: [true, 'Date and time are required']
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  image: {
    fileName: { type: String, default: null },
    fileSize: { type: String, default: null },
    fileType: { type: String, default: null },
    dataUrl: { type: String, default: null }
  },
  contact: {
    contactName: { type: String, default: 'ไม่ได้ระบุ' },
    contactInfo: {
      type: String,
      required: [true, 'Contact information is required'],
      trim: true
    }
  },
  status: {
    type: String,
    enum: ['OPEN', 'PENDING_APPROVAL', 'RESOLVED'],
    default: 'OPEN'
  },
  claimantInstagram: {
    type: String,
    trim: true,
    default: null
  },
  claimRequestedAt: {
    type: Date,
    default: null
  },
  comments: [{
    text: { type: String, required: true, trim: true },
    isAdmin: { type: Boolean, default: false },
    senderName: { type: String, default: 'ผู้ใช้ทั่วไป (นิรนาม)' },
    createdAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// TTL Index: ลบข้อมูลอัตโนมัติหลังจากสร้างครบ 3 วัน (259,200 วินาที)
ItemSchema.index({ createdAt: 1 }, { expireAfterSeconds: 259200 });

const Item = mongoose.model('Item', ItemSchema);

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

// 1. Health check
app.get('/api/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
  res.json({ status: 'Server running', database: dbStatus });
});

// 2. POST /api/admin/verify - ตรวจสอบรหัสผ่านแอดมิน
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, message: 'ยืนยันสิทธิ์แอดมินสำเร็จ' });
  }
  return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
});

// 3. POST /api/items - แจ้งของหาย / พบของ
app.post('/api/items', async (req, res) => {
  try {
    const { reportType, itemName, category, location, dateTime, description, image, contact } = req.body;

    const newItem = new Item({
      reportType,
      itemName,
      category,
      location,
      dateTime: dateTime ? new Date(dateTime) : new Date(),
      description,
      image: image || null,
      contact
    });

    const savedItem = await newItem.save();
    return res.status(201).json({
      success: true,
      message: 'Item report successfully saved to MongoDB!',
      data: savedItem
    });
  } catch (error) {
    console.error('Error saving item:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to save item report'
    });
  }
});

// 4. GET /api/items - ดึงรายการทั้งหมด (ซ่อน IG ถ้าไม่ใช่แอดมิน เพื่อความปลอดภัยและเป็นส่วนตัว)
app.get('/api/items', async (req, res) => {
  try {
    const { type, status, category, search } = req.query;
    const adminPassword = req.headers['x-admin-password'];
    const isAdmin = (adminPassword === ADMIN_PASSWORD);

    const filter = {};

    if (type) filter.reportType = type.toUpperCase();
    if (status) filter.status = status.toUpperCase();
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { itemName: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const items = await Item.find(filter).sort({ createdAt: -1 });

    // หากไม่ใช่แอดมิน ให้เซ็นเซอร์ IG ไม่ให้คนทั่วไปเห็น
    const sanitizedItems = items.map(item => {
      const obj = item.toObject();
      if (!isAdmin && obj.claimantInstagram) {
        // ซ่อน IG สำหรับบุคคลทั่วไป (คงไว้เพียงสัญลักษณ์ว่ามีคนขอรับแล้ว)
        obj.claimantInstagram = '***ซ่อนข้อมูล (เฉพาะแอดมินที่เห็น)***';
      }
      return obj;
    });

    return res.json({
      success: true,
      count: sanitizedItems.length,
      data: sanitizedItems
    });
  } catch (error) {
    console.error('Error fetching items:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve items'
    });
  }
});

// 5. POST /api/items/:id/claim - ผู้รับของส่งคำขอยืนยัน (กรอก Instagram)
app.post('/api/items/:id/claim', async (req, res) => {
  try {
    const { instagram } = req.body;
    if (!instagram || !instagram.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณากรอก Instagram ของผู้รับของ' });
    }

    let cleanIg = instagram.trim();
    if (!cleanIg.startsWith('@')) cleanIg = '@' + cleanIg;

    const item = await Item.findByIdAndUpdate(
      req.params.id,
      {
        status: 'PENDING_APPROVAL',
        claimantInstagram: cleanIg,
        claimRequestedAt: new Date()
      },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการสิ่งของนี้' });
    }

    return res.json({
      success: true,
      message: 'ส่งคำขอรับของเรียบร้อยแล้ว รอแอดมินตรวจสอบ',
      data: item
    });
  } catch (error) {
    console.error('Error claiming item:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 6. POST /api/items/:id/approve - แอดมิน Approve (ต้องผ่าน verifyAdmin)
app.post('/api/items/:id/approve', verifyAdmin, async (req, res) => {
  try {
    const item = await Item.findByIdAndUpdate(
      req.params.id,
      { status: 'RESOLVED' },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการสิ่งของนี้' });
    }

    return res.json({
      success: true,
      message: 'อนุมัติเรียบร้อย! ย้ายรายการไปยัง "พบเจ้าของแล้ว"',
      data: item
    });
  } catch (error) {
    console.error('Error approving item:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 7. POST /api/items/:id/reject - แอดมิน Reject (ต้องผ่าน verifyAdmin)
app.post('/api/items/:id/reject', verifyAdmin, async (req, res) => {
  try {
    const item = await Item.findByIdAndUpdate(
      req.params.id,
      {
        status: 'OPEN',
        claimantInstagram: null,
        claimRequestedAt: null
      },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการสิ่งของนี้' });
    }

    return res.json({
      success: true,
      message: 'ปฏิเสธคำขอเรียบร้อย รายการกลับสู่สถานะปกติ',
      data: item
    });
  } catch (error) {
    console.error('Error rejecting claim:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 8. POST /api/items/:id/comments - ส่งคอมเมนต์ / สนทนาในโพสต์สิ่งของ
app.post('/api/items/:id/comments', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
    }

    const item = await Item.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการสิ่งของนี้' });
    }

    // กฎ: ประวัติการแชทจะโดนบล็อก/ปิดรับข้อความใหม่เมื่อมีการส่งคืนเรียบร้อยแล้ว (RESOLVED)
    if (item.status === 'RESOLVED') {
      return res.status(403).json({
        success: false,
        message: 'รายการนี้ได้รับการส่งคืนเรียบร้อยแล้ว การสนทนาถูกปิดไม่ให้ส่งข้อความเพิ่ม'
      });
    }

    // ตรวจสอบว่าคนพิมพ์เป็นแอดมินหรือไม่จาก header
    const adminPassword = req.headers['x-admin-password'];
    const isAdmin = (adminPassword === ADMIN_PASSWORD);

    const newComment = {
      text: text.trim(),
      isAdmin: isAdmin,
      senderName: isAdmin ? 'แอดมิน (Admin)' : 'ผู้ใช้ทั่วไป (นิรนาม)',
      createdAt: new Date()
    };

    item.comments.push(newComment);
    await item.save();

    return res.status(201).json({
      success: true,
      message: 'ส่งข้อความสำเร็จ',
      data: item.comments
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 9. DELETE /api/items/:id - แอดมินลบโพสต์ออกจาก MongoDB ทันที (ต้องผ่าน verifyAdmin)
app.delete('/api/items/:id', verifyAdmin, async (req, res) => {
  try {
    const item = await Item.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการสิ่งของนี้' });
    }

    console.log(`[Item Deleted by Admin] ${item.itemName} (${item._id})`);
    return res.json({
      success: true,
      message: `ลบโพสต์ "${item.itemName}" ออกจากระบบเรียบร้อยแล้ว`,
      data: item
    });
  } catch (error) {
    console.error('Error deleting item:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// -------------------------------------------------------------
// Database Connection & Server Startup
// -------------------------------------------------------------
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas successfully!');
    app.listen(PORT, () => {
      console.log(`🚀 Found It! Server is running at: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    app.listen(PORT, () => {
      console.log(`🚀 Server started on http://localhost:${PORT} (Waiting for MongoDB)`);
    });
  });
