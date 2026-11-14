@echo off
"%LOCALAPPDATA%\Programs\Coloop\resources\runtime\node\node.exe" "%LOCALAPPDATA%\Programs\Coloop\resources\cli\coloop-cli.mjs" %*
exit /b %errorlevel%
