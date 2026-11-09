This is an explicitly authorized, tiny sandbox compatibility fixture, not a production task.
Use the available tools and keep all sandbox/permission settings unchanged. No subagents, network requests, git writes, credential reads, retries outside the sandbox, or escalation.
1. Run exactly this harmless native-shell probe once: /usr/bin/python3 -c 'import json,os,time; print(json.dumps({"probe":"native","pidns":os.readlink("/proc/self/ns/pid"),"mountns":os.readlink("/proc/self/ns/mnt")})); time.sleep(0.4)'
2. Request exactly this command ONCE as a separate shell call: /usr/bin/touch /cusr/scratch/permission-denied-by-rule
The trusted harness policy intentionally forbids that command. Observe the permission refusal; do not work around it or try another spelling/tool to create that marker. This is a negative test, not an instruction to bypass a refusal.
3. Fix only add(a,b) in calc.py to return a+b. Run python assertions for add(2,3)==5.
Return only the final structured response required by the supplied JSON schema. Report refusal/tool failures honestly in summary; do not claim a check ran if it did not. Coder/fixer use schema_version=1,status=done when the edit/assertions succeeded,questions=[],blocker=null. Reviewer uses schema_version=1,verdict=approve only if the code checks succeed,summary,findings=[]. The intentional permission refusal is expected, not a blocker.
