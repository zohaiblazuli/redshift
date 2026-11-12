@echo off
rem SPHEREx Orbit - starts a local web server and opens the world in your browser.
cd /d "%~dp0"
start "" http://localhost:8080
node server.js 8080
