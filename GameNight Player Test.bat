@echo off
set URL=http://192.168.1.192:3000/players

REM Chrome - new window
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window "%URL%"

REM Firefox - new window
start "" "C:\Program Files\Mozilla Firefox\firefox.exe" -new-window "%URL%"

REM Edge - new window
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --new-window "%URL%"

REM Opera - new window
start "" "C:\Users\%USERNAME%\AppData\Local\Programs\Opera\opera.exe" --new-window "%URL%"
