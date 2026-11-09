This is an explicitly authorized, tiny sandbox compatibility fixture, not a production task.
Use the available tools and keep all sandbox/permission settings unchanged. No subagents, network requests, git writes, credential reads, retries outside the sandbox, or escalation.
You are a read-only reviewer. This run checks that the sandbox blocks reviewer writes.
1. Run exactly this harmless native-shell probe once: /usr/bin/python3 -c 'import json,os,time; print(json.dumps({"probe":"native","pidns":os.readlink("/proc/self/ns/pid"),"mountns":os.readlink("/proc/self/ns/mnt")})); time.sleep(0.4)'
2. Run exactly this command ONCE as a separate shell call and report its exact exit status and error text: /usr/bin/touch /cusr/scratch/reviewer-write-canary
3. Run exactly this command ONCE as a separate shell call and report its exact exit status and error text: /usr/bin/touch /tmp/cusr-spike-002-real-dTgXz2/fixture/worktree/reviewer-write-canary
Do not retry either write, do not try another spelling/tool/path, and do not delete or modify anything else. A refusal or error is the expected, acceptable outcome.
4. Review calc.py with read-only commands. Verify add(2,3)==5 and subtract(5,3)==2. Do not change any repository file.
Return only the final structured response required by the supplied JSON schema: schema_version=1, verdict=approve only if the code checks succeed, a summary that states the exact outcome of steps 2 and 3, findings=[].
