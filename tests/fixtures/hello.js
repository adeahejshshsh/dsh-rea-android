const { ipcRenderer } = require("electron");
function greet(n){ return "hi " + n; }
module.exports = { greet };
