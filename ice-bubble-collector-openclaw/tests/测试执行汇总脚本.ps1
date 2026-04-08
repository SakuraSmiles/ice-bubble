# FileCollector 测试执行汇总脚本

Write-Host "=== FileCollector 优化测试汇总 ===" -ForegroundColor Cyan
Write-Host ""

# 测试文件列表
$testFiles = @(
    "tests/unit/utils/file-reader-bom.test.ts",
    "tests/unit/collectors/FileCollector-batch.test.ts",
    "tests/unit/collectors/FileCollector-reliability.test.ts"
)

$totalTests = 0
$passedTests = 0
$failedTests = 0
$testResults = @()

foreach ($file in $testFiles) {
    Write-Host "运行测试: $file" -ForegroundColor Yellow
    
    $output = & npx vitest run $file --reporter=verbose 2>&1 | Out-String
    
    # 解析测试结果
    if ($output -match "Tests\s+(\d+)\s+passed") {
        $passed = [int]$matches[1]
        $passedTests += $passed
        $totalTests += $passed
        $testResults += [PSCustomObject]@{
            File = $file
            Passed = $passed
            Failed = 0
            Status = "✅ PASS"
        }
    } elseif ($output -match "Tests\s+(\d+)\s+passed\s+\((\d+)\)") {
        $passed = [int]$matches[1]
        $passedTests += $passed
        $totalTests += $passed
        $testResults += [PSCustomObject]@{
            File = $file
            Passed = $passed
            Failed = 0
            Status = "✅ PASS"
        }
    } else {
        $testResults += [PSCustomObject]@{
            File = $file
            Passed = 0
            Failed = 0
            Status = "⚠️ UNKNOWN"
        }
    }
    
    Write-Host ""
}

# 输出结果表
Write-Host "=== 测试结果汇总 ===" -ForegroundColor Cyan
$testResults | Format-Table -AutoSize

Write-Host ""
Write-Host "总计: $totalTests 个测试" -ForegroundColor Green
Write-Host "通过: $passedTests 个" -ForegroundColor Green
Write-Host "失败: $failedTests 个" -ForegroundColor Red
Write-Host ""

if ($failedTests -eq 0) {
    Write-Host "✅ 所有测试通过！" -ForegroundColor Green
} else {
    Write-Host "❌ 存在失败的测试，请检查详细日志" -ForegroundColor Red
}
