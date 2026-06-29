@echo off
setlocal
cd /d C:\Users\tgaut\eod-api
if not exist output\rebotics-scheduled-closeout mkdir output\rebotics-scheduled-closeout
echo [%date% %time%] Starting store 391 dbkey 9032258 scheduled closeout>> output\rebotics-scheduled-closeout\store-391_dbkey-9032258_scheduled.log
node scripts\close-rebotics-recovered-task.js --apply >> output\rebotics-scheduled-closeout\store-391_dbkey-9032258_scheduled.log 2>&1
set EXITCODE=%ERRORLEVEL%
echo [%date% %time%] Finished with exit code %EXITCODE%>> output\rebotics-scheduled-closeout\store-391_dbkey-9032258_scheduled.log
exit /b %EXITCODE%
