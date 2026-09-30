export type CommitIdentity = { readonly oid: string; readonly authorLine: string; readonly subject: string };

// After the stack changed, picks the commit to keep showing: the same commit, else its rewritten successor (matched like drafts are, by author line with the subject as tie-break), else whatever now sits at the same position.
export function reselect(previous: CommitIdentity & { readonly index: number }, commits: readonly CommitIdentity[]): number | undefined {
	if (commits.length === 0) {
		return undefined;
	}
	const same = commits.findIndex((c) => c.oid === previous.oid);
	if (same !== -1) {
		return same;
	}
	const byAuthor = commits.flatMap((c, i) => (c.authorLine === previous.authorLine ? [i] : []));
	if (byAuthor.length === 1) {
		return byAuthor[0];
	}
	const bySubject = byAuthor.find((i) => commits[i]?.subject === previous.subject);
	if (bySubject !== undefined) {
		return bySubject;
	}
	return Math.min(previous.index, commits.length - 1);
}
