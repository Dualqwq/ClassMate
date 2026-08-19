import { createHash } from 'crypto';
import * as path from 'path';
import {
	Language,
	Parser,
	type Node as TSNode,
} from 'web-tree-sitter';

/**
 * 工作区 C/C++ 符号索引。只回答"结构事实":
 * 有哪些符号、定义在哪、函数体是否为空/只有注释、非空语句数、调用了哪些名字。
 * 不对算法正确性发表意见——那是编译/测试与模型判断的职责。
 */
export interface CppSymbol {
	/** 稳定目标 ID:同文件同容器同名的符号跨重建保持不变(与行号无关)。 */
	targetId: string;
	file: string;
	name: string;
	kind: 'class' | 'function' | 'method' | 'constructor' | 'destructor' | 'operator'
		| 'field' | 'macro';
	/** 所属类名;顶层符号没有容器。 */
	container?: string;
	startLine: number;
	endLine: number;
	body?: CppBodyFacts;
}

export interface CppBodyFacts {
	empty: boolean;
	commentOnly: boolean;
	nonEmptyStatementCount: number;
	/** 函数体内出现过的调用名(含成员调用与流写入),供存在性核对。 */
	calledNames: string[];
}

export interface CppWorkspaceIndex {
	symbols: CppSymbol[];
	/** 解析失败的文件只降级、不伪造符号。 */
	degradedFiles: Array<{ file: string; reason: string }>;
}

export interface CppIndexSourceFile {
	path: string;
	content: string;
}

let parserReady: Promise<Parser> | undefined;

export interface TreeSitterWasmLocation {
	grammar: string;
	runtime?: string;
}

function locateWasm(bases: string[], relatives: string[]): string | undefined {
	for (const base of bases) {
		for (const relative of relatives) {
			const candidate = path.resolve(base, relative);
			if (require('fs').existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/**
 * tree-sitter wasm 定位(导出供测试与诊断):
 * 基准目录优先级 = 显式 extensionPath(扩展安装根,VSIX 布局) >
 * __dirname 本身(webpack 打平产物,dist/wasm 就在旁边) >
 * __dirname/..(VSIX/源码根) > __dirname/../..(src|out 布局,根在两层上)。
 * 只依赖 __dirname 推导的旧逻辑假设"两层向上=项目根",在打包布局
 * (dist/extension.js)下会高一级,导致真实扩展宿主全部候选落空。
 */
export function locateTreeSitterWasm(extensionBases: string[]): TreeSitterWasmLocation | undefined {
	const bases = [
		...extensionBases,
		__dirname,
		path.join(__dirname, '..'),
		path.resolve(__dirname, '..', '..'),
	];
	const runtime = locateWasm(bases, [
		path.join('dist', 'wasm', 'web-tree-sitter.wasm'),
		path.join('wasm', 'web-tree-sitter.wasm'),
		path.join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
	]);
	// C++ 语法是 C 的超集:教学作业是 .h/.cpp,类/继承/运算符重载只有
	// tree-sitter-cpp 认识(tree-sitter-c 会把 class 整体解析成 ERROR)。
	// cpp 语法不可用时回退到 c 语法,索引质量降级但可用。
	const grammar = locateWasm(bases, [
			path.join('dist', 'wasm', 'tree-sitter-cpp.wasm'),
			path.join('wasm', 'tree-sitter-cpp.wasm'),
			path.join('node_modules', 'tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
		])
		?? locateWasm(bases, [
			path.join('dist', 'wasm', 'tree-sitter-c.wasm'),
			path.join('wasm', 'tree-sitter-c.wasm'),
			path.join('node_modules', 'tree-sitter-c', 'tree-sitter-c.wasm'),
		]);
	if (!grammar) {
		return undefined;
	}
	return { grammar, runtime };
}

async function loadParser(extensionPath?: string): Promise<Parser> {
	// 失败不缓存:一次定位/加载失败(如临时布局缺 wasm)不能毁掉整个
	// 会话的后续轮次,下一轮允许重试。
	const attempt = (async () => {
		const located = locateTreeSitterWasm(extensionPath ? [extensionPath] : []);
		if (!located) {
			throw new Error(
				'tree-sitter wasm grammar not found; expected tree-sitter-cpp or tree-sitter-c under the extension or node_modules.'
			);
		}
		if (located.runtime) {
			await Parser.init({
				locateFile: () => located.runtime!,
			});
		} else {
			await Parser.init();
		}
		const language = await Language.load(located.grammar);
		const parser = new Parser();
		parser.setLanguage(language);
		return parser;
	})();
	parserReady = attempt;
	try {
		return await attempt;
	} catch (error) {
		parserReady = undefined;
		throw error;
	}
}

function targetIdOf(file: string, container: string | undefined, name: string): string {
	return `sym:${file}${container ? `:${container}` : ''}:${name}`;
}

const NODE_TYPE_BY_KIND = new Set([
	'function_definition',
	'class_specifier',
	'struct_specifier',
	'preproc_def',
	'field_declaration',
]);

function findDescendant(node: TSNode, types: string[]): TSNode | undefined {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i)!;
		if (types.includes(child.type)) {
			return child;
		}
		const found = findDescendant(child, types);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * cpp 语法下类内方法名是 field_identifier,类外函数名是 identifier,
 * 运算符/析构在 declarator 文本里(operator== / ~Monster)。
 * 只在 declarator 子树内找名字,避免把参数类型误当函数名。
 */
function functionName(definition: TSNode): string | undefined {
	const declarator = findDescendant(definition, ['function_declarator', 'declaration']);
	if (!declarator) {
		return undefined;
	}
	const nameNode = findDescendant(declarator, [
		'field_identifier',
		'identifier',
		'operator_name',
		'destructor_name',
	]);
	return nameNode?.text;
}

function classifyFunction(name: string, container: string | undefined): CppSymbol['kind'] {
	if (name.startsWith('operator')) {
		return 'operator';
	}
	if (!container) {
		return 'function';
	}
	if (name === container) {
		return 'constructor';
	}
	if (name === `~${container}`) {
		return 'destructor';
	}
	return 'method';
}

function collectCalledNames(body: TSNode): string[] {
	const names = new Set<string>();
	// callee 的两种形态:identifier(普通调用 foo())和
	// field_expression(成员调用 player.takeDamage():对象是 argument 里的
	// identifier,字段才是被调名,必须取 field_expression 的最后一个
	// field_identifier,否则会把对象名当调用名)。
	const calleeName = (callee: TSNode): string | undefined => {
		if (callee.type === 'identifier') {
			return callee.text;
		}
		if (callee.type === 'field_expression') {
			let last: TSNode | undefined;
			const visit = (node: TSNode): void => {
				if (node.type === 'field_identifier') {
					last = node;
				}
				for (let i = 0; i < node.childCount; i++) {
					visit(node.child(i)!);
				}
			};
			visit(callee);
			return last?.text;
		}
		return findDescendant(callee, ['identifier', 'field_identifier'])?.text;
	};
	const visit = (node: TSNode): void => {
		if (node.type === 'call_expression') {
			const callee = node.child(0);
			const name = callee ? calleeName(callee) : undefined;
			if (name) {
				names.add(name);
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			visit(node.child(i)!);
		}
	};
	visit(body);
	return [...names];
}

function bodyFacts(body: TSNode): CppBodyFacts {
	const statementTypes = new Set([
		'expression_statement',
		'declaration_statement',
		'if_statement',
		'for_statement',
		'while_statement',
		'do_statement',
		'switch_statement',
		'return_statement',
		'break_statement',
		'continue_statement',
	]);
	let statements = 0;
	let commentNodes = 0;
	let other = 0;
	for (let i = 0; i < body.childCount; i++) {
		const child = body.child(i)!;
		if (child.type === '{' || child.type === '}') {
			continue;
		}
		if (child.type === 'comment') {
			commentNodes++;
			continue;
		}
		if (statementTypes.has(child.type)) {
			statements++;
			continue;
		}
		other++;
	}
	return {
		empty: statements === 0,
		commentOnly: statements === 0 && commentNodes > 0,
		nonEmptyStatementCount: statements,
		calledNames: collectCalledNames(body),
	};
}

function walkNode(
	node: TSNode,
	file: string,
	container: string | undefined,
	symbols: CppSymbol[]
): void {
	if (!NODE_TYPE_BY_KIND.has(node.type)) {
		// 容器内的其他节点仍要继续下钻(field_declaration 在 class 内,
		// function_definition 可能嵌在 class 内)。
		for (let i = 0; i < node.childCount; i++) {
			walkNode(node.child(i)!, file, container, symbols);
		}
		return;
	}

	if (node.type === 'preproc_def') {
		const nameNode = findDescendant(node, ['identifier']);
		if (nameNode) {
			symbols.push({
				targetId: targetIdOf(file, undefined, nameNode.text),
				file,
				name: nameNode.text,
				kind: 'macro',
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
		}
		return;
	}

	if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
		// 类名是 class_specifier 的直接 type_identifier 子节点;
		// 不能用 findDescendant,否则会抓到基类名(public Creature 的 Creature)。
		let nameNode: TSNode | undefined;
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i)!;
			if (child.type === 'type_identifier') {
				nameNode = child;
				break;
			}
		}
		if (nameNode) {
			symbols.push({
				targetId: targetIdOf(file, undefined, nameNode.text),
				file,
				name: nameNode.text,
				kind: 'class',
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
			for (let i = 0; i < node.childCount; i++) {
				walkNode(node.child(i)!, file, nameNode.text, symbols);
			}
		}
		return;
	}

	if (node.type === 'field_declaration') {
		const nameNode = findDescendant(node, ['field_identifier', 'identifier']);
		if (nameNode) {
			symbols.push({
				targetId: targetIdOf(file, container, nameNode.text),
				file,
				name: nameNode.text,
				kind: 'field',
				container,
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
		}
		return;
	}

	// function_definition:名字取自 declarator 子树(类内 field_identifier/
	// 类外 identifier/运算符/析构)。
	const name = functionName(node);
	if (!name) {
		return;
	}
	const body = findDescendant(node, ['compound_statement']);
	symbols.push({
		targetId: targetIdOf(file, container, name),
		file,
		name,
		kind: classifyFunction(name, container),
		container,
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		body: body ? bodyFacts(body) : undefined,
	});
	// 类外的函数定义(如 out-of-line 成员)不再下钻。
}

export async function buildCppWorkspaceIndex(
	files: CppIndexSourceFile[],
	options?: { extensionPath?: string }
): Promise<CppWorkspaceIndex> {
	const parser = await loadParser(options?.extensionPath);
	const symbols: CppSymbol[] = [];
	const degradedFiles: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		if (file.content.includes('\u0000')) {
			degradedFiles.push({
				file: file.path,
				reason: 'Content contains NUL bytes; likely binary.',
			});
			continue;
		}
		try {
			const tree = parser.parse(file.content);
			if (!tree) {
				throw new Error('Parser returned no tree.');
			}
			if (tree.rootNode.hasError) {
				// 语法错误不阻断:能提取多少算多少,但记录降级事实。
				degradedFiles.push({
					file: file.path,
					reason: 'Parse completed with syntax errors; extracted symbols may be partial.',
				});
			}
			walkNode(tree.rootNode, file.path, undefined, symbols);
		} catch (error) {
			degradedFiles.push({
				file: file.path,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	symbols.sort((a, b) =>
		a.file.localeCompare(b.file)
			|| (a.container ?? '').localeCompare(b.container ?? '')
			|| a.name.localeCompare(b.name)
			|| a.startLine - b.startLine
	);
	// 稳定排序后重写 targetId 里的序号无关内容:直接用语义键即可,
	// 同名同容器重复(重载)在索引层保留全部条目,targetId 以行号消歧。
	for (const symbol of symbols) {
		const duplicates = symbols.filter((other) =>
			other.file === symbol.file
				&& other.container === symbol.container
				&& other.name === symbol.name
		);
		if (duplicates.length > 1) {
			symbol.targetId = `${symbol.targetId}@${symbol.startLine}`;
		}
	}
	void createHash;
	return { symbols, degradedFiles };
}
