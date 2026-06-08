const Database = require("better-sqlite3");
const db = new Database("/home/dabai/.local/share/ice-bubble/data/admin.db");

// Check for MEDIA: prefix in messages
const rows1 = db.prepare("SELECT id, substr(content,1,400) as preview, message_type FROM admin_messages WHERE content LIKE 'MEDIA:%' LIMIT 5").all();
console.log("=== MEDIA: prefix ===");
rows1.forEach(r => console.log(JSON.stringify(r)));

// Check for [media attached
const rows2 = db.prepare("SELECT id, substr(content,1,400) as preview, message_type FROM admin_messages WHERE content LIKE '%[media attached%' LIMIT 5").all();
console.log("\n=== media attached ===");
rows2.forEach(r => console.log(JSON.stringify(r)));

// Check for data:image in content
const rows3 = db.prepare("SELECT id, substr(content,1,200) as preview, message_type FROM admin_messages WHERE content LIKE '%data:image%' LIMIT 3").all();
console.log("\n=== data:image ===");
rows3.forEach(r => console.log(JSON.stringify(r)));

// Check for screenshots
const rows4 = db.prepare("SELECT id, substr(content,1,300) as preview, message_type FROM admin_messages WHERE content LIKE '%screenshot%' LIMIT 5").all();
console.log("\n=== screenshot ===");
rows4.forEach(r => console.log(JSON.stringify(r)));

// Count attachments
const attCount = db.prepare("SELECT COUNT(*) as cnt FROM attachments").get();
console.log("\n=== Attachments count:", JSON.stringify(attCount));

// Check if any message references attachments via file_path
const rows5 = db.prepare("SELECT id, substr(content,1,400) as preview FROM admin_messages WHERE content LIKE '%attachments%' OR content LIKE '%file_path%' OR content LIKE '%.png%' LIMIT 5").all();
console.log("\n=== png refs ===");
rows5.forEach(r => console.log(JSON.stringify(r)));

db.close();
