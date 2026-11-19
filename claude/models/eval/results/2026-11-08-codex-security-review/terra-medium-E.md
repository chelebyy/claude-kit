**Medium — Heredoc input can make the model guard time out and fail open**  
[model-guard.cjs:102](/<workdir>/claude/hooks/model-guard.cjs:102) · Confidence: high · Evidence: commit diff and local timing probe

The new `/\\*$/` expression searches a line for trailing backslashes. On a line containing many backslashes followed by a non-backslash character, it retries from each position and takes quadratic time. A Bash command can place such a line in an unquoted heredoc, followed by a call using an unapproved model. The guard may time out before inspecting the call; its documented fail-open behavior then permits the tool call.

A read-only Node probe took approximately **0.1 seconds for 20,000**, **0.4 seconds for 40,000**, and **1.6 seconds for 80,000** backslashes, showing the quadratic growth. This did not measure the actual hook timeout, so the precise payload size needed depends on the host.

Count trailing backslashes with a single backward scan, and add a regression check that verifies oversized input is denied or processed within the hook’s time limit.

Reviewed the exact commit and relevant surrounding guard and evaluation code. I did not run an end-to-end hook timeout or execute an unapproved model call.