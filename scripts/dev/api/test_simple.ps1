Write-Host "=== Simple API Test ===" -ForegroundColor Cyan 
 
# Test 1: Health check 
Write-Host "`n1. Testing health endpoint..." -ForegroundColor Yellow 
try { 
    $health = Invoke-RestMethod -Uri "http://localhost:3003/api/health" -Method Get 
    Write-Host "✅ Health: $($health.status) - $($health.message)" -ForegroundColor Green 
} catch { 
    Write-Host "❌ Health check failed: $($_.Exception.Message)" -ForegroundColor Red 
    exit 
} 
 
# Test 2: Create quiz 
Write-Host "`n2. Creating test quiz..." -ForegroundColor Yellow 
try { 
    $quizData = @{ 
        title = "Math Test" 
        questionCount = 5 
        options = 4 
    } 
     
    $body = $quizData | ConvertTo-Json 
    $quiz = Invoke-RestMethod -Uri "http://localhost:3003/api/quizzes" -Method Post -ContentType "application/json" -Body $body 
    Write-Host "✅ Quiz created: ID $($quiz.id) - $($quiz.title)" -ForegroundColor Green 
     
    # Test 3: Save answer key 
    Write-Host "`n3. Saving answer key..." -ForegroundColor Yellow 
    $answerData = @{ 
        answers = @("A", "B", "C", "D", "A") 
    } | ConvertTo-Json 
     
    $answerKey = Invoke-RestMethod -Uri "http://localhost:3003/api/quizzes/$($quiz.id)/answer-key" -Method Post -ContentType "application/json" -Body $answerData 
    Write-Host "✅ Answer key saved!" -ForegroundColor Green 
     
    # Test 4: Get answer key 
    Write-Host "`n4. Retrieving answer key..." -ForegroundColor Yellow 
    $retrieved = Invoke-RestMethod -Uri "http://localhost:3003/api/quizzes/$($quiz.id)/answer-key" -Method Get 
    Write-Host "✅ Answer key: $($retrieved.answers -join ', ')" -ForegroundColor Green 
     
} catch { 
    Write-Host "❌ Test failed: $($_.Exception.Message)" -ForegroundColor Red 
    Write-Host "Full error details:" -ForegroundColor Yellow 
    Write-Host $_.Exception -ForegroundColor Yellow 
} 
 
Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan