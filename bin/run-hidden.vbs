' Runs a command with no console window and appends its output to a log file. Windows' Task Scheduler runs slate's
' morning and its Sunday review through this, so nothing flashes on the screen at seven (SPEC §21.7).
'   wscript.exe run-hidden.vbs <log file> <program> [arguments...]
' The command line is wrapped in one more pair of quotes for cmd.exe, which strips the outer pair and keeps every
' quoted path inside intact — the documented rule for /C when there are more than two quotes on the line.
Set sh = CreateObject("WScript.Shell")
Set a = WScript.Arguments
If a.Count < 2 Then WScript.Quit 2
log = a(0)
cmd = ""
For i = 1 To a.Count - 1
  cmd = cmd & " """ & a(i) & """"
Next
sh.Run "cmd.exe /d /c """ & cmd & " >> """ & log & """ 2>&1""", 0, True
