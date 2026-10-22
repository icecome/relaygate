param([int]$Port = 19900, [switch]$Apply)
# 结束占用 relay-gate 端口的孤儿 node。srvany 停止服务时只杀 cmd 包装进程，
# node 子进程会存活并继续占住端口，导致新实例起不来或双调度器并存。
# 服务会话进程的 CommandLine 对普通查询不可见，无法按脚本路径匹配，
# 故以「监听指定端口」为准 —— 该端口专属于 relay-gate。
$owners = @()
try {
  $owners = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop).OwningProcess | Select-Object -Unique
} catch {
  exit 0
}
foreach ($op in $owners) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$op" -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.Name -ne 'node.exe') { continue }
  if ($Apply) {
    Write-Output ("[relay-gate] killing orphaned node pid " + $op + " holding port " + $Port)
    Stop-Process -Id $op -Force -ErrorAction SilentlyContinue
  } else {
    Write-Output ("[dry-run] would kill pid " + $op + " holding port " + $Port)
  }
}
