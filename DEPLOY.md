# Deploy Content Dashboard ขึ้น Render

โฟลเดอร์นี้พร้อม deploy แล้ว — เสิร์ฟเฉพาะ `public/` (content dashboard + ข้อมูล)
ไฟล์อื่นในเครื่องจะ **ไม่** ถูกเปิด public

```
content-dashboard-deploy/
├─ public/
│   ├─ content-dashboard.html   ← หน้า Dashboard
│   └─ content-data.json        ← ข้อมูล (May 2026, ฝังไว้แล้ว)
├─ server.js                    ← Express เสิร์ฟเฉพาะ public/
├─ package.json                 ← start + update-data
├─ fetch-sheet-data.js          ← อัปเดตข้อมูลจาก Google Sheet
├─ render.yaml                  ← ตั้งค่า Render (Blueprint)
└─ .gitignore
```

---

## ขั้นที่ 1 — ขึ้น GitHub (รันใน Terminal ของคุณเอง ที่ล็อกอิน GitHub ได้)

> ทำไมต้องรันเอง: ในเครื่องนี้ git ของโปรเจกต์เสีย + push อัตโนมัติไม่ผ่าน auth
> รันจาก Terminal ปกติของคุณจะใช้ credential ที่ล็อกอินไว้แล้วได้เลย

สร้าง repo ใหม่สำหรับ content dashboard (สะอาดสุด ไม่ยุ่งกับ repo sales เดิม):

```powershell
cd "C:\Users\bonphiphop\Desktop\claude\content-dashboard-deploy"
git init
git add -A
git commit -m "Content performance dashboard"
git branch -M main
# สร้าง repo เปล่าชื่อ content-dashboard บน github.com ก่อน แล้วใส่ URL ของคุณ:
git remote add origin https://github.com/buraphiphopsmp-lgtm/content-dashboard.git
git push -u origin main
```

---

## ขั้นที่ 2 — สร้าง Web Service บน Render

1. ไปที่ https://render.com → ล็อกอิน → **New +** → **Web Service**
2. **Connect a repository** → เลือก repo `content-dashboard` (กด Configure GitHub ให้สิทธิ์ถ้าจำเป็น)
3. Render จะอ่าน `render.yaml` ให้เอง หรือกรอกเอง:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. กด **Create Web Service** — รอ build ~1-2 นาที
5. ได้ลิงก์สาธารณะ เช่น `https://content-dashboard.onrender.com` → แชร์ทีมได้เลย

> ⚠️ Free plan จะ "หลับ" เมื่อไม่มีคนเข้าสักพัก ครั้งแรกที่เปิดอาจช้า ~30 วิ (ปกติ)

---

## ขั้นที่ 3 — อัปเดตข้อมูลภายหลัง

ตอนนี้ข้อมูลเดือน May 2026 ฝังไว้ใน `public/content-data.json` แล้ว ใช้งานได้ทันที

เมื่อต้องการดึงข้อมูลใหม่จากชีต:
1. เปิดสิทธิ์ชีตเป็น *Anyone with the link → Viewer*
2. ใส่ `gid` ของแท็บใน `fetch-sheet-data.js` (ดูเลขหลัง `gid=` บน URL แต่ละแท็บ)
3. รัน + push:
   ```powershell
   npm install
   npm run update-data
   git add public/content-data.json
   git commit -m "update data"
   git push
   ```
   Render (autoDeploy) จะ build ใหม่ให้อัตโนมัติ

---

## ทดสอบในเครื่องก่อน (ถ้าติดตั้ง Node ไว้)
```powershell
npm install
npm start
# เปิด http://localhost:3000
```
