const m = await import('../hive.js');
console.log('hive.js loaded, exports:', Object.keys(m));
const g = await import('../shapes.js');
console.log('shapes.js loaded:', typeof g.configure, typeof g.drawCell);
