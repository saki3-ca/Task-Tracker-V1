/**
 * Code.gs – ACNABIN Task Tracker Backend (Workflow v2.0 - Production Ready)
 * Implements: Client Master, Manager-Client Access, Manager-Student Access,
 * Designation-based permissions, Dual-Mode API (google.script.run + HTTP/JSON for Vercel/GitHub).
 */

// ============================================================================
// CONSTANTS & SHEET NAMES
// ============================================================================
var SHEET_NAMES = {
    USERS: 'Users',
    CLIENTS: 'Clients',
    MANAGER_STUDENT_ACCESS: 'ManagerStudentAccess',
    MANAGER_CLIENT_ACCESS: 'ManagerClientAccess',
    TASKS: 'Tasks',
    RESET_TOKENS: 'PasswordResetTokens',
    SESSIONS: 'Sessions',
    ACTIVITY_LOG: 'ActivityLog',
    CONFIG: 'Config',
    APP_SETTINGS: 'AppSettings'
};

var SHEET_HEADERS = {
    Users: ['UserID', 'Name', 'EmpStdID', 'Email', 'PasswordHash', 'Role', 'Designation', 'SignupClientID', 'Status', 'CreatedDate', 'UpdatedDate', 'LastLogin'],
    Clients: ['ClientID', 'ClientName', 'JobNumber', 'Status', 'CreatedDate', 'LastUpdated'],
    ManagerStudentAccess: ['AccessID', 'ManagerUserID', 'StudentUserID', 'Status', 'CreatedBy', 'CreatedDate', 'LastUpdated'],
    ManagerClientAccess: ['AccessID', 'ManagerUserID', 'ClientID', 'Status', 'CreatedBy', 'CreatedDate', 'LastUpdated'],
    Tasks: ['TaskID', 'ClientID', 'AssignedTo', 'CreatedBy', 'Particular', 'Priority', 'Deadline', 'Status', 'Remarks', 'ManagerComment', 'CreatedDate', 'LastUpdated', 'AssignedDate'],
    PasswordResetTokens: ['TokenID', 'UserID', 'TokenHash', 'Expiry', 'Used', 'CreatedDate'],
    Sessions: ['SessionID', 'UserID', 'TokenHash', 'CreatedDate', 'Expiry'],
    ActivityLog: ['LogID', 'UserID', 'Action', 'TargetType', 'TargetID', 'Timestamp', 'Details'],
    Config: ['Key', 'Value'],
    AppSettings: ['SettingKey', 'SettingValue']
};

var DESIGNATIONS = ['Student', 'Senior Assistant Manager', 'Deputy Manager', 'Manager', 'Assistant Director', 'Deputy Director', 'Director', 'Partner'];
var VALID_PRIORITIES = ['High', 'Medium', 'Low'];
var VALID_STATUSES = ['Pending', 'In Progress', 'Completed'];
var SESSION_LIFETIME_HOURS = 12;
var RESET_TOKEN_LIFETIME_MINUTES = 60;

// Per-execution in-memory read cache to minimize spreadsheet round-trips
var _MEMO_CACHE = {};

function clearExecutionCache_() {
    _MEMO_CACHE = {};
}

// ============================================================================
// WEB APP ENTRY POINTS (doGet & doPost)
// ============================================================================

/**
 * Handles GET requests:
 * 1. Serves HTML frontend when accessed directly in browser.
 * 2. Handles password reset link (?token=...).
 * 3. Serves API endpoints when called with ?api=1.
 */
function doGet(e) {
    e = e || { parameter: {} };
    var params = e.parameter || {};

    // API Mode for external frontend (Vercel / GitHub)
    if (params.api === '1' || params.action) {
        return handleApiRequest_(params.action, params);
    }

    // Serve HTML Template for native Google Apps Script deployment
    try {
        var template = HtmlService.createTemplateFromFile('Index');
        template.resetToken = params.token || '';
        return template.evaluate()
            .setTitle('ACNABIN Task Tracker')
            .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
            .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (err) {
        return ContentService.createTextOutput('Error loading application: ' + err.message);
    }
}

/**
 * Handles POST requests for external frontend (Vercel / GitHub).
 * Note: To prevent browser CORS preflight (OPTIONS) failures, client sends Content-Type: text/plain.
 */
function doPost(e) {
    try {
        var payload = {};
        if (e && e.postData && e.postData.contents) {
            try {
                payload = JSON.parse(e.postData.contents);
            } catch (pErr) {
                payload = e.parameter || {};
            }
        } else if (e && e.parameter) {
            payload = e.parameter;
        }

        var action = payload.action;
        return handleApiRequest_(action, payload);
    } catch (err) {
        return jsonResponse_({ success: false, error: err.message || 'Unknown server error' }, 500);
    }
}

/**
 * Dispatches API actions for external requests
 */
function handleApiRequest_(action, payload) {
    try {
        var args = payload.args || [];
        var result;
        var token = payload.sessionToken || payload.token || args[0];

        switch (action) {
            case 'loginUser':
                result = loginUser(args[0] !== undefined ? args[0] : payload.empId, args[1] !== undefined ? args[1] : payload.password);
                break;
            case 'registerUser':
                result = registerUser(args[0] !== undefined ? args[0] : (payload.payload || payload));
                break;
            case 'logoutUser':
                result = logoutUser(token);
                break;
            case 'validateSession':
                result = validateSession(token);
                break;
            case 'requestPasswordReset':
                result = requestPasswordReset(args[0] !== undefined ? args[0] : payload.email);
                break;
            case 'resetPassword':
                result = resetPassword(args[0] !== undefined ? args[0] : (payload.resetToken || payload.token), args[1] !== undefined ? args[1] : (payload.newPassword || payload.password));
                break;
            case 'getActiveClients':
                result = getActiveClients(token);
                break;
            case 'getAllClients':
                result = getAllClients(token);
                break;
            case 'searchClients':
                result = searchClients(token, args[1] !== undefined ? args[1] : payload.searchTerm);
                break;
            case 'addClient':
                result = addClient(token, args[1] !== undefined ? args[1] : payload.clientName);
                break;
            case 'updateClient':
                result = updateClient(token, args[1] !== undefined ? args[1] : payload.clientId, args[2] !== undefined ? args[2] : payload.clientName, args[3] !== undefined ? args[3] : payload.jobNumber, args[4] !== undefined ? args[4] : payload.status);
                break;
            case 'deactivateClient':
                result = deactivateClient(token, args[1] !== undefined ? args[1] : payload.clientId);
                break;
            case 'reactivateClient':
                result = reactivateClient(token, args[1] !== undefined ? args[1] : payload.clientId);
                break;
            case 'getTeamMembers':
                result = getTeamMembers(token);
                break;
            case 'getAllUsers':
                result = getAllUsers(token);
                break;
            case 'updateUserDesignation':
                result = updateUserDesignation(token, args[1] !== undefined ? args[1] : payload.userId, args[2] !== undefined ? args[2] : payload.designation);
                break;
            case 'updateUserClient':
                result = updateUserClient(token, args[1] !== undefined ? args[1] : payload.userId, args[2] !== undefined ? args[2] : payload.clientId);
                break;
            case 'updateUserRole':
                result = updateUserRole(token, args[1] !== undefined ? args[1] : payload.userId, args[2] !== undefined ? args[2] : payload.role);
                break;
            case 'updateUserStatus':
                result = updateUserStatus(token, args[1] !== undefined ? args[1] : payload.userId, args[2] !== undefined ? args[2] : payload.status);
                break;
            case 'getManagerClients':
                result = getManagerClients(token, args[1] !== undefined ? args[1] : payload.managerId);
                break;
            case 'assignManagerToClient':
                result = assignManagerToClient(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.clientId);
                break;
            case 'revokeManagerFromClient':
                result = revokeManagerFromClient(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.clientId);
                break;
            case 'batchSaveManagerClients':
                result = batchSaveManagerClients(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.clientIds);
                break;
            case 'getManagerStudents':
                result = getManagerStudents(token, args[1] !== undefined ? args[1] : payload.managerId);
                break;
            case 'assignManagerToStudent':
                result = assignManagerToStudent(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.studentId);
                break;
            case 'revokeManagerFromStudent':
                result = revokeManagerFromStudent(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.studentId);
                break;
            case 'batchSaveManagerStudents':
                result = batchSaveManagerStudents(token, args[1] !== undefined ? args[1] : payload.managerId, args[2] !== undefined ? args[2] : payload.studentIds);
                break;
            case 'getAppSettings':
                result = getAppSettings(token);
                break;
            case 'updateAppSetting':
                result = updateAppSetting(token, args[1] !== undefined ? args[1] : payload.key, args[2] !== undefined ? args[2] : payload.value);
                break;
            case 'getMyTasks':
                result = getMyTasks(token);
                break;
            case 'getTasks':
                result = getTasks(token, args[1] !== undefined ? args[1] : (payload.filters || {}));
                break;
            case 'createTask':
                result = createTask(token, args[1] !== undefined ? args[1] : (payload.payload || payload));
                break;
            case 'updateTask':
                result = updateTask(token, args[1] !== undefined ? args[1] : payload.taskId, args[2] !== undefined ? args[2] : (payload.payload || payload));
                break;
            case 'deleteTask':
                result = deleteTask(token, args[1] !== undefined ? args[1] : payload.taskId);
                break;
            case 'addManagerComment':
                result = addManagerComment(token, args[1] !== undefined ? args[1] : payload.taskId, args[2] !== undefined ? args[2] : payload.comment);
                break;
            default:
                throw new Error('Unknown action: ' + action);
        }

        return jsonResponse_({ success: true, data: result });
    } catch (err) {
        return jsonResponse_({ success: false, error: err.message || 'Request failed' });
    }
}

function jsonResponse_(obj) {
    return ContentService
        .createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function getOrCreateSheet_(name) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
        sheet = ss.insertSheet(name);
        var headers = SHEET_HEADERS[name];
        if (headers) {
            sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
            sheet.setFrozenRows(1);
            if (name === 'Users') sheet.getRange(2, 3, Math.max(10, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
        }
    }
    return sheet;
}

function readAllRows_(sheetName, bypassCache) {
    if (!bypassCache && _MEMO_CACHE[sheetName]) {
        return _MEMO_CACHE[sheetName];
    }

    var sheet = getOrCreateSheet_(sheetName);
    var lastRow = sheet.getLastRow();
    var headers = SHEET_HEADERS[sheetName];
    if (!headers) return [];
    var lastCol = headers.length;
    if (lastRow < 2) {
        _MEMO_CACHE[sheetName] = [];
        return [];
    }

    var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
        var row = values[i];
        var obj = { _row: i + 2 };
        for (var c = 0; c < headers.length; c++) {
            var val = row[c];
            if (val instanceof Date) {
                val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
            }
            if (typeof val === 'string') val = val.trim();
            obj[headers[c]] = val;
        }
        out.push(obj);
    }
    _MEMO_CACHE[sheetName] = out;
    return out;
}

function appendRow_(sheetName, obj) {
    var sheet = getOrCreateSheet_(sheetName);
    var headers = SHEET_HEADERS[sheetName];
    if (!headers) return -1;
    var row = headers.map(function(h) { return (obj[h] === undefined || obj[h] === null) ? '' : obj[h]; });
    sheet.appendRow(row);
    delete _MEMO_CACHE[sheetName];
    return sheet.getLastRow();
}

function updateRowFields_(sheetName, rowObj, fields) {
    var sheet = getOrCreateSheet_(sheetName);
    var headers = SHEET_HEADERS[sheetName];
    if (!headers) return;
    Object.keys(fields).forEach(function(key) {
        var colIndex = headers.indexOf(key);
        if (colIndex === -1) return;
        sheet.getRange(rowObj._row, colIndex + 1).setValue(fields[key]);
        rowObj[key] = fields[key];
    });
    delete _MEMO_CACHE[sheetName];
}

function deleteRow_(sheetName, rowNumber) {
    var sheet = getOrCreateSheet_(sheetName);
    sheet.deleteRow(rowNumber);
    delete _MEMO_CACHE[sheetName];
}

function generateId_(prefix) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
        var sheetName = SHEET_NAMES[prefix.toUpperCase()] || (prefix === 'TSK' ? SHEET_NAMES.TASKS : (prefix === 'CLI' ? SHEET_NAMES.CLIENTS : prefix + 's'));
        var sheet = getOrCreateSheet_(sheetName);
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) return prefix + '-001';
        var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
        var maxNum = 0;
        ids.forEach(function(id) {
            var m = new RegExp('^' + prefix + '-(\\d+)$').exec(String(id || ''));
            if (m) {
                var n = parseInt(m[1], 10);
                if (n > maxNum) maxNum = n;
            }
        });
        var next = maxNum + 1;
        return prefix + '-' + ('000' + next).slice(-3);
    } finally {
        lock.releaseLock();
    }
}

function generateUuid_() { return Utilities.getUuid(); }

function nowIso_() { return new Date().toISOString(); }

function isEmptyOrWhitespace_(s) { return !s || String(s).trim() === ''; }

function normalizeEmpId_(empId) {
    return String(empId || '').trim().replace(/^0+/, '') || '0';
}

function logActivity_(userId, action, targetType, targetId, details) {
    try {
        appendRow_(SHEET_NAMES.ACTIVITY_LOG, {
            LogID: generateUuid_(),
            UserID: userId || '',
            Action: action || '',
            TargetType: targetType || '',
            TargetID: targetId || '',
            Timestamp: nowIso_(),
            Details: details ? JSON.stringify(details) : ''
        });
    } catch (e) { /* swallow logging errors */ }
}

function authError_(message) {
    var e = new Error(message || 'You are not authorized to access this resource.');
    e.isAuthError = true;
    return e;
}

// ============================================================================
// SECURITY & CRYPTOGRAPHY
// ============================================================================
function sha256Hex_(input) {
    var rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
    return rawHash.map(function(b) {
        var v = (b < 0 ? b + 256 : b).toString(16);
        return v.length === 1 ? '0' + v : v;
    }).join('');
}

function hashPassword_(password) {
    var salt = generateUuid_();
    var hash = sha256Hex_(password + salt);
    return salt + '$' + hash;
}

function verifyPassword_(password, stored) {
    if (!stored || stored.indexOf('$') === -1) return false;
    var parts = stored.split('$');
    var salt = parts[0];
    var hash = parts[1];
    return sha256Hex_(password + salt) === hash;
}

function generateRandomToken_() { return generateUuid_() + generateUuid_(); }

function hashToken_(token) { return sha256Hex_(token); }

// ============================================================================
// APP SETTINGS
// ============================================================================
function getAppSetting_(key, defaultVal) {
    var sheet = getOrCreateSheet_(SHEET_NAMES.APP_SETTINGS);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === key) {
            return data[i][1];
        }
    }
    return defaultVal;
}

function setAppSetting_(key, value) {
    var sheet = getOrCreateSheet_(SHEET_NAMES.APP_SETTINGS);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === key) {
            sheet.getRange(i + 1, 2).setValue(value);
            return;
        }
    }
    sheet.appendRow([key, value]);
}

function getAllAppSettings_() {
    var sheet = getOrCreateSheet_(SHEET_NAMES.APP_SETTINGS);
    var data = sheet.getDataRange().getValues();
    var settings = {};
    for (var i = 1; i < data.length; i++) {
        settings[data[i][0]] = data[i][1];
    }
    return settings;
}

function getAppSettings(sessionToken) {
    requireSession_(sessionToken);
    return getAllAppSettings_();
}

function updateAppSetting(sessionToken, key, value) {
    requireAdmin_(sessionToken);
    setAppSetting_(key, value);
    return { success: true };
}

// ============================================================================
// EMAIL SERVICE
// ============================================================================
function sendPasswordResetEmail_(email, name, resetUrl) {
    var subject = 'ACNABIN Task Tracker — Password Reset Request';
    var body =
        'Hi ' + (name || '') + ',\n\n' +
        'We received a request to reset your ACNABIN Task Tracker password.\n\n' +
        'Click the link below to choose a new password. This link expires in ' + RESET_TOKEN_LIFETIME_MINUTES + ' minutes and can only be used once:\n\n' +
        resetUrl + '\n\n' +
        'If you did not request this, you can safely ignore this email — your password will not change.\n\n' +
        'ACNABIN Chartered Accountants';

    MailApp.sendEmail({
        to: email,
        subject: subject,
        body: body
    });
}

// ============================================================================
// INTERNAL HELPER LOOKUPS
// ============================================================================
function findUserById_(userId) {
    var users = readAllRows_(SHEET_NAMES.USERS);
    return users.find(function(u) { return u.UserID === userId; }) || null;
}

function getManagerAuthorizedClients_(managerUserId) {
    return readAllRows_(SHEET_NAMES.MANAGER_CLIENT_ACCESS)
        .filter(function(a) { return a.ManagerUserID === managerUserId && a.Status === 'ACTIVE'; })
        .map(function(a) { return a.ClientID; });
}

function getCurrentManagerForClient_(clientId) {
    var access = readAllRows_(SHEET_NAMES.MANAGER_CLIENT_ACCESS)
        .find(function(a) { return a.ClientID === clientId && a.Status === 'ACTIVE'; });
    return access ? access.ManagerUserID : null;
}

function seedInitialClients_() {
    var sheet = getOrCreateSheet_(SHEET_NAMES.CLIENTS);
    if (sheet.getLastRow() >= 2) return;
    var now = nowIso_();
    var initial = [
        ['CLI-001', 'ACNABIN Internal', 'INT-001', 'ACTIVE', now, now],
        ['CLI-002', 'General Audit Practice', 'AUD-100', 'ACTIVE', now, now]
    ];
    initial.forEach(function(row) { sheet.appendRow(row); });
    delete _MEMO_CACHE[SHEET_NAMES.CLIENTS];
}

// ============================================================================
// AUTH
// ============================================================================
function registerUser(payload) {
    payload = payload || {};
    var name = (payload.name || '').trim();
    var empId = (payload.empId || '').trim();
    var email = (payload.email || '').trim().toLowerCase();
    var password = payload.password || '';
    var confirmPassword = payload.confirmPassword || '';
    var designation = payload.designation || '';
    var clientId = payload.clientId || '';

    if (isEmptyOrWhitespace_(name)) throw new Error('Name is required.');
    if (!/^[a-zA-Z0-9]{2,4}$/.test(empId)) {
        throw new Error('EMP/STD ID must be 2-4 alphanumeric characters.');
    }
    if (isEmptyOrWhitespace_(email) || email.indexOf('@') === -1) {
        throw new Error('A valid email is required.');
    }
    if (isEmptyOrWhitespace_(password) || password.length < 6) {
        throw new Error('Password must be at least 6 characters.');
    }
    if (password !== confirmPassword) {
        throw new Error('Password and Confirm Password do not match.');
    }
    if (!designation || DESIGNATIONS.indexOf(designation) === -1) {
        throw new Error('Please select a valid designation.');
    }

    if (designation === 'Student' && isEmptyOrWhitespace_(clientId)) {
        throw new Error('Students must select a Client.');
    }

    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var normalizedEmpId = normalizeEmpId_(empId);
    var empTaken = users.some(function(u) { return normalizeEmpId_(u.EmpStdID) === normalizedEmpId; });
    if (empTaken) throw new Error('This EMP/STD ID is already registered.');
    var emailTaken = users.some(function(u) { return String(u.Email).toLowerCase() === email; });
    if (emailTaken) throw new Error('This email is already associated with an account.');

    if (designation !== 'Student' && clientId) {
        throw new Error('Only students can be assigned a client during registration.');
    }
    if (clientId) {
        var clients = readAllRows_(SHEET_NAMES.CLIENTS);
        var clientExists = clients.some(function(c) { return c.ClientID === clientId && c.Status === 'ACTIVE'; });
        if (!clientExists) throw new Error('Selected client is not available. Please contact administrator.');
    }

    var userId = generateUuid_();
    var now = nowIso_();

    // Students are auto-active; management designations require admin approval
    var role = 'USER';
    var status = designation === 'Student' ? 'ACTIVE' : 'PENDING';

    appendRow_(SHEET_NAMES.USERS, {
        UserID: userId,
        Name: name,
        EmpStdID: normalizedEmpId,
        Email: email,
        PasswordHash: hashPassword_(password),
        Role: role,
        Designation: designation,
        SignupClientID: clientId || '',
        Status: status,
        CreatedDate: now,
        UpdatedDate: now,
        LastLogin: ''
    });

    logActivity_(userId, 'USER_REGISTERED', 'User', userId, { empId: empId, designation: designation });

    if (designation === 'Student' && clientId) {
        var manager = getCurrentManagerForClient_(clientId);
        if (!manager) {
            logActivity_(userId, 'STUDENT_NO_MANAGER', 'User', userId, { clientId: clientId });
        }
    }

    return {
        success: true,
        message: status === 'ACTIVE' ? 'Account created successfully.' : 'Account created and submitted for administrator approval.'
    };
}

function loginUser(empId, password) {
    empId = (empId || '').trim();
    password = password || '';
    if (isEmptyOrWhitespace_(empId) || isEmptyOrWhitespace_(password)) {
        throw new Error('Invalid EMP/STD ID or password.');
    }

    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var normalizedEmpId = normalizeEmpId_(empId);
    var user = users.find(function(u) { return normalizeEmpId_(u.EmpStdID) === normalizedEmpId; });
    if (!user || !verifyPassword_(password, user.PasswordHash)) {
        throw new Error('Invalid EMP/STD ID or password.');
    }

    if (user.Status !== 'ACTIVE') {
        throw new Error('This account is inactive or pending approval. Please contact your administrator.');
    }

    var token = generateRandomToken_();
    var expiry = new Date(Date.now() + SESSION_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
    appendRow_(SHEET_NAMES.SESSIONS, {
        SessionID: generateUuid_(),
        UserID: user.UserID,
        TokenHash: hashToken_(token),
        CreatedDate: nowIso_(),
        Expiry: expiry
    });

    updateRowFields_(SHEET_NAMES.USERS, user, { LastLogin: nowIso_() });

    logActivity_(user.UserID, 'USER_LOGIN', 'User', user.UserID, {});

    return {
        sessionToken: token,
        user: publicUser_(user)
    };
}

function logoutUser(sessionToken) {
    var session = findSessionRow_(sessionToken);
    if (session) {
        deleteRow_(SHEET_NAMES.SESSIONS, session._row);
        logActivity_(session.UserID, 'USER_LOGOUT', 'User', session.UserID, {});
    }
    return { success: true };
}

function requireSession_(sessionToken) {
    if (isEmptyOrWhitespace_(sessionToken)) throw authError_('Your session has expired. Please log in again.');
    var session = findSessionRow_(sessionToken);
    if (!session) throw authError_('Your session has expired. Please log in again.');
    if (new Date(session.Expiry).getTime() < Date.now()) {
        deleteRow_(SHEET_NAMES.SESSIONS, session._row);
        throw authError_('Your session has expired. Please log in again.');
    }
    var users = readAllRows_(SHEET_NAMES.USERS);
    var user = users.find(function(u) { return u.UserID === session.UserID; });
    if (!user || user.Status !== 'ACTIVE') throw authError_('Your account is no longer active.');
    return user;
}

function requireAdmin_(sessionToken) {
    var user = requireSession_(sessionToken);
    if (user.Role !== 'ADMIN') {
        throw authError_('You are not authorized to access this resource.');
    }
    return user;
}

function isManagementDesignation_(designation) {
    return ['Manager', 'Senior Assistant Manager', 'Deputy Manager', 'Assistant Director',
        'Deputy Director', 'Director', 'Partner'
    ].indexOf(designation) !== -1;
}

function isAllAccessDesignation_(designation) {
    return ['Assistant Director', 'Deputy Director', 'Director', 'Partner'].indexOf(designation) !== -1;
}

function getAssignedStudentIds_(managerUserId) {
    return readAllRows_(SHEET_NAMES.MANAGER_STUDENT_ACCESS)
        .filter(function(a) { return a.ManagerUserID === managerUserId && a.Status === 'ACTIVE'; })
        .map(function(a) { return a.StudentUserID; });
}

function canViewStudent_(user, studentUserId) {
    if (user.Role === 'ADMIN' || isAllAccessDesignation_(user.Designation)) return true;
    if (user.Designation === 'Student' || !isManagementDesignation_(user.Designation)) {
        return studentUserId === user.UserID;
    }
    var student = findUserById_(studentUserId);
    if (!student || student.Designation !== 'Student' || student.Status !== 'ACTIVE') return false;

    // Check manager's authorized clients
    var clientAuthorized = getManagerAuthorizedClients_(user.UserID).indexOf(student.SignupClientID) !== -1;
    if (clientAuthorized) return true;

    // Also check direct student assignment
    var directlyAssigned = getAssignedStudentIds_(user.UserID).indexOf(studentUserId) !== -1;
    return directlyAssigned;
}

function getVisibleClientIds_(user) {
    if (user.Role === 'ADMIN' || isAllAccessDesignation_(user.Designation)) return null;
    if (user.Designation === 'Student' || !isManagementDesignation_(user.Designation)) {
        return user.SignupClientID ? [user.SignupClientID] : [];
    }
    return getManagerAuthorizedClients_(user.UserID);
}

function canAccessClient_(user, clientId) {
    var visibleIds = getVisibleClientIds_(user);
    return visibleIds === null || visibleIds.indexOf(clientId) !== -1;
}

function buildTaskAuthorizationContext_(user) {
    var users = readAllRows_(SHEET_NAMES.USERS);
    var userMap = {};
    users.forEach(function(candidate) { userMap[candidate.UserID] = candidate; });
    return {
        userMap: userMap,
        managerClientIds: getManagerAuthorizedClients_(user.UserID),
        assignedStudentIds: getAssignedStudentIds_(user.UserID)
    };
}

function findAuthorizedTask_(user, task, context) {
    context = context || buildTaskAuthorizationContext_(user);
    if (task.AssignedTo === user.UserID || task.CreatedBy === user.UserID) return true;
    if (user.Role === 'ADMIN' || isAllAccessDesignation_(user.Designation)) return true;
    return canViewStudent_(user, task.AssignedTo);
}

function findSessionRow_(sessionToken) {
    if (isEmptyOrWhitespace_(sessionToken)) return null;
    var tokenHash = hashToken_(sessionToken);
    var sessions = readAllRows_(SHEET_NAMES.SESSIONS, true);
    return sessions.find(function(s) { return s.TokenHash === tokenHash; }) || null;
}

function validateSession(sessionToken) {
    try {
        var user = requireSession_(sessionToken);
        return { valid: true, user: publicUser_(user) };
    } catch (e) {
        return { valid: false };
    }
}

function publicUser_(user) {
    var roleLabel = user.Role === 'ADMIN' ? 'Administrator' : 'User';
    var clients = readAllRows_(SHEET_NAMES.CLIENTS);
    var clientName = '';
    if (user.SignupClientID) {
        var client = clients.find(function(candidate) {
            return candidate.ClientID === user.SignupClientID;
        });
        clientName = client ? client.ClientName : '';
    }
    var clientNames = [];
    if (isManagementDesignation_(user.Designation)) {
        var managerClientIds = getManagerAuthorizedClients_(user.UserID);
        clientNames = clients.filter(function(candidate) {
            return managerClientIds.indexOf(candidate.ClientID) !== -1 && candidate.Status === 'ACTIVE';
        }).map(function(candidate) { return candidate.ClientName; });
    }
    return {
        id: user.UserID,
        name: user.Name,
        empId: normalizeEmpId_(user.EmpStdID),
        email: user.Email,
        role: user.Role,
        roleLabel: roleLabel,
        designation: user.Designation || '',
        clientId: user.SignupClientID || '',
        clientName: clientName,
        clientNames: clientNames,
        status: user.Status
    };
}

function getCurrentUser(sessionToken) {
    var user = requireSession_(sessionToken);
    return publicUser_(user);
}

function requestPasswordReset(email) {
    email = (email || '').trim().toLowerCase();
    var genericResponse = { success: true, message: 'If an account is associated with this email, a password reset link has been sent.' };
    if (isEmptyOrWhitespace_(email)) return genericResponse;

    var users = readAllRows_(SHEET_NAMES.USERS);
    var user = users.find(function(u) { return String(u.Email).toLowerCase() === email; });
    if (!user) return genericResponse;

    var token = generateRandomToken_();
    var expiry = new Date(Date.now() + RESET_TOKEN_LIFETIME_MINUTES * 60 * 1000).toISOString();
    appendRow_(SHEET_NAMES.RESET_TOKENS, {
        TokenID: generateUuid_(),
        UserID: user.UserID,
        TokenHash: hashToken_(token),
        Expiry: expiry,
        Used: false,
        CreatedDate: nowIso_()
    });

    var serviceUrl = ScriptApp.getService().getUrl();
    var resetUrl = serviceUrl ? (serviceUrl + '?token=' + encodeURIComponent(token)) : ('?token=' + encodeURIComponent(token));
    sendPasswordResetEmail_(user.Email, user.Name, resetUrl);
    logActivity_(user.UserID, 'PASSWORD_RESET_REQUESTED', 'User', user.UserID, {});

    return genericResponse;
}

function resetPassword(token, newPassword) {
    if (isEmptyOrWhitespace_(token)) throw new Error('This reset link is invalid or has expired.');
    if (isEmptyOrWhitespace_(newPassword) || newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters.');
    }

    var tokenHash = hashToken_(token);
    var tokens = readAllRows_(SHEET_NAMES.RESET_TOKENS, true);
    var record = tokens.find(function(t) { return t.TokenHash === tokenHash; });
    if (!record || record.Used === true || record.Used === 'TRUE') {
        throw new Error('This reset link is invalid or has expired.');
    }
    if (new Date(record.Expiry).getTime() < Date.now()) {
        throw new Error('This reset link is invalid or has expired.');
    }

    var users = readAllRows_(SHEET_NAMES.USERS);
    var user = users.find(function(u) { return u.UserID === record.UserID; });
    if (!user) throw new Error('This reset link is invalid or has expired.');

    updateRowFields_(SHEET_NAMES.USERS, user, {
        PasswordHash: hashPassword_(newPassword),
        UpdatedDate: nowIso_()
    });
    updateRowFields_(SHEET_NAMES.RESET_TOKENS, record, { Used: true });
    revokeUserSessions_(user.UserID);

    logActivity_(user.UserID, 'PASSWORD_RESET', 'User', user.UserID, {});
    return { success: true, message: 'Password updated. Please log in with your new password.' };
}

function revokeUserSessions_(userId) {
    var sessions = readAllRows_(SHEET_NAMES.SESSIONS, true);
    sessions.filter(function(session) { return session.UserID === userId; })
        .sort(function(a, b) { return b._row - a._row; })
        .forEach(function(session) { deleteRow_(SHEET_NAMES.SESSIONS, session._row); });
}

// ============================================================================
// CLIENT MANAGEMENT
// ============================================================================
function searchClients(sessionToken, searchTerm) {
    var user = (sessionToken && sessionToken !== 'temp') ? requireSession_(sessionToken) : null;
    searchTerm = (searchTerm || '').trim().toLowerCase();

    var clients = readAllRows_(SHEET_NAMES.CLIENTS);
    if (clients.length === 0) {
        seedInitialClients_();
        clients = readAllRows_(SHEET_NAMES.CLIENTS, true);
    }

    var results = [];
    for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (c.Status !== 'ACTIVE') continue;
        var name = c.ClientName || '';
        if (!name) continue;

        if ((!user || canAccessClient_(user, c.ClientID)) &&
            (!searchTerm || name.toLowerCase().indexOf(searchTerm) !== -1)) {
            results.push({
                id: c.ClientID,
                name: name,
                jobNumber: c.JobNumber || ''
            });
        }
    }
    return results.slice(0, 25);
}

function getAllClients(sessionToken) {
    var user = requireSession_(sessionToken);
    var visibleIds = getVisibleClientIds_(user);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS);

    return clients.filter(function(c) {
        return visibleIds === null || visibleIds.indexOf(c.ClientID) !== -1;
    }).map(function(c) {
        return {
            id: c.ClientID,
            name: c.ClientName || '',
            jobNumber: c.JobNumber || '',
            status: c.Status || 'ACTIVE'
        };
    });
}

function getActiveClients(sessionToken) {
    var user = requireSession_(sessionToken);
    var visibleIds = getVisibleClientIds_(user);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS);

    return clients.filter(function(c) {
        return c.Status === 'ACTIVE' && (visibleIds === null || visibleIds.indexOf(c.ClientID) !== -1);
    }).map(function(c) {
        return {
            id: c.ClientID,
            name: c.ClientName || '',
            jobNumber: c.JobNumber || ''
        };
    });
}

function getTaskCreationClients(sessionToken) {
    var user = requireSession_(sessionToken);
    var clientIds = (user.Role === 'ADMIN' || isAllAccessDesignation_(user.Designation)) ?
        null : getManagerAuthorizedClients_(user.UserID);

    return readAllRows_(SHEET_NAMES.CLIENTS).filter(function(client) {
        return client.Status === 'ACTIVE' && (clientIds === null || clientIds.indexOf(client.ClientID) !== -1);
    }).map(function(client) {
        return { id: client.ClientID, name: client.ClientName, jobNumber: client.JobNumber || '' };
    });
}

function getClientById(sessionToken, clientId) {
    var user = requireSession_(sessionToken);
    if (!canAccessClient_(user, clientId)) throw authError_('You are not authorized to access this client.');
    var client = readAllRows_(SHEET_NAMES.CLIENTS).find(function(c) { return c.ClientID === clientId; });
    if (!client) return null;
    return {
        id: client.ClientID,
        name: client.ClientName || '',
        jobNumber: client.JobNumber || '',
        status: client.Status || 'ACTIVE'
    };
}

function addClient(sessionToken, clientName) {
    var admin = requireAdmin_(sessionToken);
    clientName = (clientName || '').trim();
    if (isEmptyOrWhitespace_(clientName)) throw new Error('Client name is required.');

    var clients = readAllRows_(SHEET_NAMES.CLIENTS, true);
    var exists = clients.some(function(c) { return c.ClientName.toLowerCase() === clientName.toLowerCase(); });
    if (exists) throw new Error('Client already exists.');

    var clientId = generateId_('CLI');
    var now = nowIso_();

    appendRow_(SHEET_NAMES.CLIENTS, {
        ClientID: clientId,
        ClientName: clientName,
        JobNumber: '',
        Status: 'ACTIVE',
        CreatedDate: now,
        LastUpdated: now
    });

    logActivity_(admin.UserID, 'CLIENT_ADDED', 'Client', clientId, { name: clientName });
    return { success: true, clientId: clientId, clientName: clientName };
}

function updateClient(sessionToken, clientId, clientName, jobNumber, status) {
    var admin = requireAdmin_(sessionToken);
    clientName = (clientName || '').trim();
    if (isEmptyOrWhitespace_(clientName)) throw new Error('Client name is required.');

    var clients = readAllRows_(SHEET_NAMES.CLIENTS, true);
    var client = clients.find(function(c) { return c.ClientID === clientId; });
    if (!client) throw new Error('Client not found.');

    var now = nowIso_();
    updateRowFields_(SHEET_NAMES.CLIENTS, client, {
        ClientName: clientName,
        JobNumber: jobNumber || '',
        Status: status || 'ACTIVE',
        LastUpdated: now
    });

    logActivity_(admin.UserID, 'CLIENT_UPDATED', 'Client', clientId, {
        name: clientName,
        jobNumber: jobNumber,
        status: status
    });
    return { success: true };
}

function deactivateClient(sessionToken, clientId) {
    var admin = requireAdmin_(sessionToken);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS, true);
    var client = clients.find(function(c) { return c.ClientID === clientId; });
    if (!client) throw new Error('Client not found.');

    var now = nowIso_();
    updateRowFields_(SHEET_NAMES.CLIENTS, client, {
        Status: 'INACTIVE',
        LastUpdated: now
    });

    logActivity_(admin.UserID, 'CLIENT_DEACTIVATED', 'Client', clientId, {});
    return { success: true };
}

function reactivateClient(sessionToken, clientId) {
    var admin = requireAdmin_(sessionToken);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS, true);
    var client = clients.find(function(c) { return c.ClientID === clientId; });
    if (!client) throw new Error('Client not found.');

    var now = nowIso_();
    updateRowFields_(SHEET_NAMES.CLIENTS, client, {
        Status: 'ACTIVE',
        LastUpdated: now
    });

    logActivity_(admin.UserID, 'CLIENT_REACTIVATED', 'Client', clientId, {});
    return { success: true };
}

// ============================================================================
// USER MANAGEMENT & ACCESS CONTROL
// ============================================================================
function getTeamMembers(sessionToken) {
    var user = requireSession_(sessionToken);
    var allUsers = readAllRows_(SHEET_NAMES.USERS);

    var visibleUsers = allUsers.filter(function(candidate) {
        if (candidate.Status !== 'ACTIVE') return false;
        if (candidate.UserID === user.UserID) return true;
        if (user.Role === 'ADMIN' || isAllAccessDesignation_(user.Designation)) return true;
        return canViewStudent_(user, candidate.UserID);
    });

    return visibleUsers.map(function(u) {
        return {
            userId: u.UserID,
            name: u.Name,
            empId: normalizeEmpId_(u.EmpStdID),
            email: u.Email,
            designation: u.Designation || '',
            role: u.Role || 'USER',
            status: u.Status || 'ACTIVE',
            clientId: u.SignupClientID || ''
        };
    });
}

function getAllUsers(sessionToken) {
    requireAdmin_(sessionToken);
    var allUsers = readAllRows_(SHEET_NAMES.USERS);

    return allUsers.map(function(u) {
        return {
            userId: u.UserID,
            name: u.Name,
            empId: normalizeEmpId_(u.EmpStdID),
            email: u.Email,
            designation: u.Designation || '',
            role: u.Role || 'USER',
            status: u.Status || 'ACTIVE',
            clientId: u.SignupClientID || ''
        };
    });
}

function updateUserDesignation(sessionToken, userId, designation) {
    var admin = requireAdmin_(sessionToken);
    if (DESIGNATIONS.indexOf(designation) === -1) throw new Error('Invalid designation.');

    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var user = users.find(function(u) { return u.UserID === userId; });
    if (!user) throw new Error('User not found.');

    updateRowFields_(SHEET_NAMES.USERS, user, {
        Designation: designation,
        UpdatedDate: nowIso_()
    });

    logActivity_(admin.UserID, 'USER_DESIGNATION_UPDATED', 'User', userId, { designation: designation });
    return { success: true };
}

function updateUserClient(sessionToken, userId, clientId) {
    var admin = requireAdmin_(sessionToken);
    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var user = users.find(function(u) { return u.UserID === userId; });
    if (!user) throw new Error('User not found.');

    if (clientId) {
        var clients = readAllRows_(SHEET_NAMES.CLIENTS);
        var clientExists = clients.some(function(c) { return c.ClientID === clientId; });
        if (!clientExists) throw new Error('Client not found.');
    }

    updateRowFields_(SHEET_NAMES.USERS, user, {
        SignupClientID: clientId || '',
        UpdatedDate: nowIso_()
    });

    logActivity_(admin.UserID, 'USER_CLIENT_UPDATED', 'User', userId, { clientId: clientId });
    return { success: true };
}

function updateUserRole(sessionToken, userId, role) {
    var admin = requireAdmin_(sessionToken);
    if (role !== 'USER' && role !== 'ADMIN') throw new Error('Invalid role.');

    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var user = users.find(function(u) { return u.UserID === userId; });
    if (!user) throw new Error('User not found.');

    updateRowFields_(SHEET_NAMES.USERS, user, {
        Role: role,
        UpdatedDate: nowIso_()
    });

    logActivity_(admin.UserID, 'USER_ROLE_UPDATED', 'User', userId, { role: role });
    return { success: true };
}

function updateUserStatus(sessionToken, userId, status) {
    var admin = requireAdmin_(sessionToken);
    if (status !== 'ACTIVE' && status !== 'INACTIVE' && status !== 'PENDING') throw new Error('Invalid status.');

    var users = readAllRows_(SHEET_NAMES.USERS, true);
    var user = users.find(function(u) { return u.UserID === userId; });
    if (!user) throw new Error('User not found.');

    updateRowFields_(SHEET_NAMES.USERS, user, {
        Status: status,
        UpdatedDate: nowIso_()
    });

    if (status !== 'ACTIVE') {
        revokeUserSessions_(userId);
    }

    logActivity_(admin.UserID, 'USER_STATUS_UPDATED', 'User', userId, { status: status });
    return { success: true };
}

// Manager-Client Access
function getManagerClients(sessionToken, managerId) {
    requireAdmin_(sessionToken);
    return getManagerAuthorizedClients_(managerId);
}

function assignManagerToClient(sessionToken, managerId, clientId) {
    var admin = requireAdmin_(sessionToken);
    var rows = readAllRows_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, true);
    var existing = rows.find(function(r) { return r.ManagerUserID === managerId && r.ClientID === clientId; });

    var now = nowIso_();
    if (existing) {
        updateRowFields_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, existing, {
            Status: 'ACTIVE',
            LastUpdated: now
        });
    } else {
        appendRow_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, {
            AccessID: generateUuid_(),
            ManagerUserID: managerId,
            ClientID: clientId,
            Status: 'ACTIVE',
            CreatedBy: admin.UserID,
            CreatedDate: now,
            LastUpdated: now
        });
    }

    logActivity_(admin.UserID, 'MANAGER_CLIENT_ASSIGNED', 'ManagerClientAccess', managerId + ':' + clientId, {});
    return { success: true };
}

function revokeManagerFromClient(sessionToken, managerId, clientId) {
    var admin = requireAdmin_(sessionToken);
    var rows = readAllRows_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, true);
    var existing = rows.find(function(r) { return r.ManagerUserID === managerId && r.ClientID === clientId; });

    if (existing) {
        updateRowFields_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, existing, {
            Status: 'INACTIVE',
            LastUpdated: nowIso_()
        });
    }

    logActivity_(admin.UserID, 'MANAGER_CLIENT_REVOKED', 'ManagerClientAccess', managerId + ':' + clientId, {});
    return { success: true };
}

function batchSaveManagerClients(sessionToken, managerId, clientIds) {
    var admin = requireAdmin_(sessionToken);
    if (!managerId) throw new Error('Manager ID is required.');
    clientIds = clientIds || [];

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
        var rows = readAllRows_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, true);
        var currentMap = {};
        rows.forEach(function(r) {
            if (r.ManagerUserID === managerId) {
                currentMap[r.ClientID] = r;
            }
        });

        var now = nowIso_();
        // Activate requested clientIds
        clientIds.forEach(function(cid) {
            if (currentMap[cid]) {
                if (currentMap[cid].Status !== 'ACTIVE') {
                    updateRowFields_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, currentMap[cid], { Status: 'ACTIVE', LastUpdated: now });
                }
            } else {
                appendRow_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, {
                    AccessID: generateUuid_(),
                    ManagerUserID: managerId,
                    ClientID: cid,
                    Status: 'ACTIVE',
                    CreatedBy: admin.UserID,
                    CreatedDate: now,
                    LastUpdated: now
                });
            }
        });

        // Deactivate clientIds not in array
        Object.keys(currentMap).forEach(function(cid) {
            if (clientIds.indexOf(cid) === -1 && currentMap[cid].Status === 'ACTIVE') {
                updateRowFields_(SHEET_NAMES.MANAGER_CLIENT_ACCESS, currentMap[cid], { Status: 'INACTIVE', LastUpdated: now });
            }
        });

        logActivity_(admin.UserID, 'BATCH_MANAGER_CLIENTS_SAVED', 'ManagerClientAccess', managerId, { count: clientIds.length });
        return { success: true };
    } finally {
        lock.releaseLock();
    }
}

// Manager-Student Access
function getManagerStudents(sessionToken, managerId) {
    requireAdmin_(sessionToken);
    var allUsers = readAllRows_(SHEET_NAMES.USERS);
    var activeStudents = allUsers.filter(function(u) { return u.Designation === 'Student' && u.Status === 'ACTIVE'; });
    var assignedIds = getAssignedStudentIds_(managerId);

    return activeStudents.map(function(s) {
        return {
            id: s.UserID,
            name: s.Name,
            empId: normalizeEmpId_(s.EmpStdID),
            clientId: s.SignupClientID || '',
            assigned: assignedIds.indexOf(s.UserID) !== -1
        };
    });
}

function assignManagerToStudent(sessionToken, managerId, studentId) {
    var admin = requireAdmin_(sessionToken);
    var rows = readAllRows_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, true);
    var existing = rows.find(function(r) { return r.ManagerUserID === managerId && r.StudentUserID === studentId; });

    var now = nowIso_();
    if (existing) {
        updateRowFields_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, existing, {
            Status: 'ACTIVE',
            LastUpdated: now
        });
    } else {
        appendRow_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, {
            AccessID: generateUuid_(),
            ManagerUserID: managerId,
            StudentUserID: studentId,
            Status: 'ACTIVE',
            CreatedBy: admin.UserID,
            CreatedDate: now,
            LastUpdated: now
        });
    }

    logActivity_(admin.UserID, 'MANAGER_STUDENT_ASSIGNED', 'ManagerStudentAccess', managerId + ':' + studentId, {});
    return { success: true };
}

function revokeManagerFromStudent(sessionToken, managerId, studentId) {
    var admin = requireAdmin_(sessionToken);
    var rows = readAllRows_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, true);
    var existing = rows.find(function(r) { return r.ManagerUserID === managerId && r.StudentUserID === studentId; });

    if (existing) {
        updateRowFields_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, existing, {
            Status: 'INACTIVE',
            LastUpdated: nowIso_()
        });
    }

    logActivity_(admin.UserID, 'MANAGER_STUDENT_REVOKED', 'ManagerStudentAccess', managerId + ':' + studentId, {});
    return { success: true };
}

function batchSaveManagerStudents(sessionToken, managerId, studentIds) {
    var admin = requireAdmin_(sessionToken);
    if (!managerId) throw new Error('Manager ID is required.');
    studentIds = studentIds || [];

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
        var rows = readAllRows_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, true);
        var currentMap = {};
        rows.forEach(function(r) {
            if (r.ManagerUserID === managerId) {
                currentMap[r.StudentUserID] = r;
            }
        });

        var now = nowIso_();
        studentIds.forEach(function(sid) {
            if (currentMap[sid]) {
                if (currentMap[sid].Status !== 'ACTIVE') {
                    updateRowFields_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, currentMap[sid], { Status: 'ACTIVE', LastUpdated: now });
                }
            } else {
                appendRow_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, {
                    AccessID: generateUuid_(),
                    ManagerUserID: managerId,
                    StudentUserID: sid,
                    Status: 'ACTIVE',
                    CreatedBy: admin.UserID,
                    CreatedDate: now,
                    LastUpdated: now
                });
            }
        });

        Object.keys(currentMap).forEach(function(sid) {
            if (studentIds.indexOf(sid) === -1 && currentMap[sid].Status === 'ACTIVE') {
                updateRowFields_(SHEET_NAMES.MANAGER_STUDENT_ACCESS, currentMap[sid], { Status: 'INACTIVE', LastUpdated: now });
            }
        });

        logActivity_(admin.UserID, 'BATCH_MANAGER_STUDENTS_SAVED', 'ManagerStudentAccess', managerId, { count: studentIds.length });
        return { success: true };
    } finally {
        lock.releaseLock();
    }
}

// ============================================================================
// TASK MANAGEMENT
// ============================================================================
function isTaskOverdue_(task) {
    if (!task.Deadline || task.Status === 'Completed') return false;
    var deadlineDate = new Date(task.Deadline + 'T23:59:59');
    if (isNaN(deadlineDate.getTime())) return false;
    return deadlineDate.getTime() < Date.now();
}

function decorateTask_(task, userMap, clientMap) {
    var assignedUser = userMap[task.AssignedTo];
    var createdUser = userMap[task.CreatedBy];
    var client = clientMap[task.ClientID];

    return {
        taskId: task.TaskID,
        clientId: task.ClientID,
        clientName: client ? client.ClientName : (task.ClientID || '—'),
        assignedTo: task.AssignedTo,
        assignedToName: assignedUser ? assignedUser.Name : '—',
        assignedToEmpId: assignedUser ? normalizeEmpId_(assignedUser.EmpStdID) : '—',
        createdBy: task.CreatedBy,
        createdByName: createdUser ? createdUser.Name : '—',
        particular: task.Particular || '',
        priority: task.Priority || 'Medium',
        assignedDate: task.AssignedDate || '',
        deadline: task.Deadline || '',
        status: task.Status || 'Pending',
        remarks: task.Remarks || '',
        managerComment: task.ManagerComment || '',
        isOverdue: isTaskOverdue_(task),
        createdDate: task.CreatedDate || '',
        lastUpdated: task.LastUpdated || ''
    };
}

function getMyTasks(sessionToken) {
    var user = requireSession_(sessionToken);
    var tasks = readAllRows_(SHEET_NAMES.TASKS);
    var users = readAllRows_(SHEET_NAMES.USERS);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS);

    var userMap = {};
    users.forEach(function(u) { userMap[u.UserID] = u; });
    var clientMap = {};
    clients.forEach(function(c) { clientMap[c.ClientID] = c; });

    var myTasks = tasks.filter(function(t) {
        return t.AssignedTo === user.UserID;
    });

    return myTasks.map(function(t) {
        return decorateTask_(t, userMap, clientMap);
    }).sort(function(a, b) {
        if (a.isOverdue && !b.isOverdue) return -1;
        if (!a.isOverdue && b.isOverdue) return 1;
        return (a.deadline || '').localeCompare(b.deadline || '');
    });
}

function getTasks(sessionToken, filters) {
    var user = requireSession_(sessionToken);
    filters = filters || {};

    if (user.Role !== 'ADMIN' && !isManagementDesignation_(user.Designation)) {
        throw authError_('Only managers and administrators can view team and client tasks.');
    }

    var tasks = readAllRows_(SHEET_NAMES.TASKS);
    var users = readAllRows_(SHEET_NAMES.USERS);
    var clients = readAllRows_(SHEET_NAMES.CLIENTS);

    var userMap = {};
    users.forEach(function(u) { userMap[u.UserID] = u; });
    var clientMap = {};
    clients.forEach(function(c) { clientMap[c.ClientID] = c; });

    var context = buildTaskAuthorizationContext_(user);

    var filtered = tasks.filter(function(t) {
        // Enforce authorization
        if (!findAuthorizedTask_(user, t, context)) return false;

        // Apply filters
        if (filters.assignedTo && t.AssignedTo !== filters.assignedTo) return false;
        if (filters.clientId && t.ClientID !== filters.clientId) return false;
        if (filters.status && t.Status !== filters.status) return false;
        if (filters.overdueOnly && !isTaskOverdue_(t)) return false;

        return true;
    });

    return filtered.map(function(t) {
        return decorateTask_(t, userMap, clientMap);
    }).sort(function(a, b) {
        if (a.isOverdue && !b.isOverdue) return -1;
        if (!a.isOverdue && b.isOverdue) return 1;
        return (a.deadline || '').localeCompare(b.deadline || '');
    });
}

function createTask(sessionToken, payload) {
    var user = requireSession_(sessionToken);
    payload = payload || {};

    var particular = (payload.particular || '').trim();
    if (isEmptyOrWhitespace_(particular)) throw new Error('Particulars are required.');

    var priority = payload.priority || 'Medium';
    if (VALID_PRIORITIES.indexOf(priority) === -1) priority = 'Medium';

    var status = payload.status || 'Pending';
    if (VALID_STATUSES.indexOf(status) === -1) status = 'Pending';

    var isManager = user.Role === 'ADMIN' || isManagementDesignation_(user.Designation);

    var assignedTo = user.UserID;
    var clientId = user.SignupClientID;

    if (isManager) {
        if (payload.clientId) {
            clientId = payload.clientId;
        }
        if (payload.assignedTo) {
            var targetUser = findUserById_(payload.assignedTo);
            if (!targetUser) throw new Error('Assigned user not found.');
            if (!canViewStudent_(user, payload.assignedTo)) {
                throw authError_('You are not authorized to assign tasks to this user.');
            }
            assignedTo = payload.assignedTo;
            // If target is student, ensure client matches
            if (targetUser.Designation === 'Student' && targetUser.SignupClientID) {
                clientId = targetUser.SignupClientID;
            }
        }
    }

    if (!clientId && user.SignupClientID) {
        clientId = user.SignupClientID;
    }

    var taskId = generateId_('TSK');
    var now = nowIso_();

    var taskRecord = {
        TaskID: taskId,
        ClientID: clientId || '',
        AssignedTo: assignedTo,
        CreatedBy: user.UserID,
        Particular: particular,
        Priority: priority,
        Deadline: payload.deadline || '',
        Status: status,
        Remarks: (payload.remarks || '').trim(),
        ManagerComment: (payload.managerComment || '').trim(),
        CreatedDate: now,
        LastUpdated: now,
        AssignedDate: payload.assignedDate || now.slice(0, 10)
    };

    appendRow_(SHEET_NAMES.TASKS, taskRecord);
    logActivity_(user.UserID, 'TASK_CREATED', 'Task', taskId, { assignedTo: assignedTo, clientId: clientId });

    return { success: true, taskId: taskId };
}

function updateTask(sessionToken, taskId, payload) {
    var user = requireSession_(sessionToken);
    payload = payload || {};

    var tasks = readAllRows_(SHEET_NAMES.TASKS, true);
    var task = tasks.find(function(t) { return t.TaskID === taskId; });
    if (!task) throw new Error('Task not found.');

    var context = buildTaskAuthorizationContext_(user);
    if (!findAuthorizedTask_(user, task, context)) {
        throw authError_('You are not authorized to edit this task.');
    }

    var updateFields = {
        LastUpdated: nowIso_()
    };

    if (payload.particular !== undefined) updateFields.Particular = String(payload.particular).trim();
    if (payload.priority !== undefined && VALID_PRIORITIES.indexOf(payload.priority) !== -1) updateFields.Priority = payload.priority;
    if (payload.deadline !== undefined) updateFields.Deadline = payload.deadline;
    if (payload.assignedDate !== undefined) updateFields.AssignedDate = payload.assignedDate;
    if (payload.status !== undefined && VALID_STATUSES.indexOf(payload.status) !== -1) updateFields.Status = payload.status;
    if (payload.remarks !== undefined) updateFields.Remarks = String(payload.remarks).trim();

    // Only managers/admins can update manager comments
    var isManager = user.Role === 'ADMIN' || isManagementDesignation_(user.Designation);
    if (isManager && payload.managerComment !== undefined) {
        updateFields.ManagerComment = String(payload.managerComment).trim();
    }

    updateRowFields_(SHEET_NAMES.TASKS, task, updateFields);
    logActivity_(user.UserID, 'TASK_UPDATED', 'Task', taskId, updateFields);

    return { success: true };
}

function deleteTask(sessionToken, taskId) {
    var user = requireSession_(sessionToken);
    var tasks = readAllRows_(SHEET_NAMES.TASKS, true);
    var task = tasks.find(function(t) { return t.TaskID === taskId; });
    if (!task) throw new Error('Task not found.');

    var isManager = user.Role === 'ADMIN' || isManagementDesignation_(user.Designation);
    var isOwner = task.CreatedBy === user.UserID || task.AssignedTo === user.UserID;

    if (!isManager && !isOwner) {
        throw authError_('You are not authorized to delete this task.');
    }

    deleteRow_(SHEET_NAMES.TASKS, task._row);
    logActivity_(user.UserID, 'TASK_DELETED', 'Task', taskId, {});

    return { success: true };
}

function addManagerComment(sessionToken, taskId, comment) {
    var user = requireSession_(sessionToken);
    if (user.Role !== 'ADMIN' && !isManagementDesignation_(user.Designation)) {
        throw authError_('Only managers can add manager comments.');
    }

    var tasks = readAllRows_(SHEET_NAMES.TASKS, true);
    var task = tasks.find(function(t) { return t.TaskID === taskId; });
    if (!task) throw new Error('Task not found.');

    var context = buildTaskAuthorizationContext_(user);
    if (!findAuthorizedTask_(user, task, context)) {
        throw authError_('You are not authorized to comment on this task.');
    }

    var now = nowIso_();
    updateRowFields_(SHEET_NAMES.TASKS, task, {
        ManagerComment: String(comment || '').trim(),
        LastUpdated: now
    });

    logActivity_(user.UserID, 'MANAGER_COMMENT_ADDED', 'Task', taskId, { comment: comment });
    return { success: true };
}
