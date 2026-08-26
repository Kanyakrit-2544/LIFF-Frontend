// ให้ `npx vitest` จาก root ใช้ config ของแต่ละ workspace (รวม setupFiles)
// ไม่งั้นรันจาก root แล้ว env test ไม่ถูกตั้ง → fail แบบงง ๆ
export default ["packages/*", "apps/*"];
