"""Ticks acceptance criteria of one story and records evidence.

Usage: python docs/stories/tools/tick.py <epic file> <story id> <all|1,2,3> "<evidence text>"

The evidence is added as an **Evidence:** line after the criteria (appended to an existing one).
Edits only the named story, in place, keeping LF line endings.
"""
import sys


def main() -> None:
    path, sid, which, evidence = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    s = open(path, encoding='utf-8').read()
    start = s.index(f'### {sid} ')
    ends = [x for x in (s.find('\n### ', start + 5), s.find('\n## ', start + 5)) if x != -1]
    end = min(ends) if ends else len(s)
    lines = s[start:end].split('\n')
    picks = None if which == 'all' else {int(x) for x in which.split(',')}
    n = 0
    last_criterion = -1
    evidence_line = -1
    for i, line in enumerate(lines):
        if line.startswith('- [ ] ') or line.startswith('- [x] '):
            n += 1
            last_criterion = i
            if picks is None or n in picks:
                lines[i] = '- [x] ' + line[6:]
        if line.startswith('**Evidence:**'):
            evidence_line = i
    if evidence:
        if evidence_line >= 0:
            lines[evidence_line] = lines[evidence_line] + ' ' + evidence
        else:
            lines.insert(last_criterion + 1, '')
            lines.insert(last_criterion + 2, f'**Evidence:** {evidence}')
    block = '\n'.join(lines)
    s = s[:start] + block + s[end:]
    open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print(f'{sid}: ticked {"all" if picks is None else sorted(picks)} of {n}')


if __name__ == '__main__':
    main()
