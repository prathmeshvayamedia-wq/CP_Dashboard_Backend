@echo off
echo.
echo ============================================
echo   PropEdge CP Backend - Windows Setup
echo ============================================
echo.

echo [1/4] Installing packages...
npm install

echo.
echo [2/4] Creating logs folder...
if not exist logs mkdir logs

echo.
echo [3/4] Creating .env file...
if not exist .env (
  copy .env.example .env
  echo .env created! Open it and fill in your SUPABASE_URL and SUPABASE_SERVICE_KEY
) else (
  echo .env already exists, skipping.
)

echo.
echo [4/4] Done!
echo.
echo ============================================
echo  Next steps:
echo  1. Open .env and add your Supabase keys
echo  2. Run: npm run dev
echo  3. Visit: http://localhost:3000/health
echo ============================================
echo.
pause
