export interface CourseContext {
    course?: string;
    currentConcept?: string;
    prerequisites: string[];
    teachingStrategy?: string;
    body: string;
}

export interface WorkspaceContext {
    /** Relative paths of C/C++ source and header files in the workspace. */
    cppFiles: string[];
    /** Latest full contents of every C/C++ source/header file. */
    codeDocuments: WorkspaceCodeDocument[];
    /** All code edit events observed during the current extension session. */
    codeChanges: WorkspaceCodeChange[];
    /** Problem statement selected for the active assignment. */
    questionText?: string;
    /** Relative path of the selected problem statement. */
    questionFile?: string;
    /** Context from the active editor at the time of the request. */
    activeEditor?: ActiveEditorContext;
    /** Parsed CLASSMATE.md frontmatter + body, if present. */
    courseContext?: CourseContext;
}

export interface WorkspaceCodeDocument {
    fileName: string;
    languageId: string;
    content: string;
}

export type WorkspaceCodeChangeKind = 'insert' | 'delete' | 'replace' | 'file_created' | 'file_deleted';

export interface WorkspaceCodeChange {
    timestamp: number;
    kind: WorkspaceCodeChangeKind;
    fileName: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    insertedText?: string;
    removedLength?: number;
}

export interface ActiveEditorContext {
    fileName: string;
    uri: string;
    languageId: string;
    content: string;
    selection?: string;
    selectionStartLine?: number;
    selectionEndLine?: number;
}
