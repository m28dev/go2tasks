'use strict';

const gotasks = {
    clientId: process.env.CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/tasks'
};

/**
 * GoogleにAuthorization Requestする（初回）
 */
gotasks.signin = event => {
    event.preventDefault();

    // ポップアップ画面でアクセストークンをもらう
    const left = (window.screen.availWidth - 550) / 2;
    const top = (window.screen.availHeight - 600) / 2;
    const url = gotasks.createAuthReq();
    window.open(url, 'oauth2callback', `width=550,height=600,left=${left},top=${top}`);
};

/**
 * GoogleにAuthorization Requestする（トークン再取得）
 */
gotasks.refresh = retry => {
    // リトライしたい処理を登録
    gotasks.observer.on(retry);

    // トークンをリクエスト
    const url = gotasks.createAuthReq();
    const iframe = document.querySelector('.refreshFrame');
    iframe.setAttribute('src', url);
};

/**
 * Authorization Requestをつくる
 */
gotasks.createAuthReq = () => {
    const oauth2Endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';

    // CSRF対策
    const state = btoa(crypto.getRandomValues(new Uint8Array(16)));
    window.sessionStorage.setItem('state', state);

    // リクエストを生成
    const clientId = encodeURIComponent(gotasks.clientId);
    const redirectUri = encodeURIComponent('http://localhost:8080/oauth2callback.html');
    const type = 'token';
    const scope = encodeURIComponent(gotasks.scope);
    const encodedState = encodeURIComponent(state);
    // TODO 複数アカウントの場合は？
    const url = `${oauth2Endpoint}?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=${type}&scope=${scope}&state=${encodedState}`;

    return url;
}

/**
 * アクセストークンの受け取り
 */
gotasks.receiveMessage = event => {
    // 送信元のチェック。自ホスト以外、またはWebpack Dev Serverの場合は処理を行わない
    if(event.origin !== 'http://localhost:8080' || event.source.frameElement === null) return;

    if (event.source.opener) {
        // ポップアップ画面から受け取ったときは初期利用として進める
        event.source.close();

        gotasks.exchangeOAuth2Token(event.data)
            .then(() => {
                // 利用開始のフラグを設定
                window.localStorage.setItem('logged-in', 'logged-in');
                return gotasks.router.navigate('#');
            }).catch(err => {
                console.log(/*window.alert(*/err); // TODO 画面にエラーを出してね
            });
    } else {
        // iframeからの場合は再取得したアクセストークンを使ってAPIを再度呼び出したいはず
        document.querySelector('.refreshFrame').setAttribute('src', 'about:blank');

        gotasks.exchangeOAuth2Token(event.data)
            .then(() => {
                return Promise.all(gotasks.observer.trigger());
            }).catch(err => {
                console.log('errrrrrrrrrrrrrrrrrr',/*window.alert(*/err); // TODO 画面にエラーを出してね
            });
    }
};

/**
 * アクセストークンを検証
 */
gotasks.exchangeOAuth2Token = fragments => {
    const params = new URLSearchParams(fragments);

    // CSRF対策
    const state = params.get('state');
    const localState = window.sessionStorage.getItem('state');

    window.sessionStorage.removeItem('state');
    if (state !== localState) {
        return Promise.reject(new Error('stateが一致しません'));
    }

    // エラーチェック
    const error = params.get('error');
    if (error) {
        return Promise.reject(new Error(error));
    }

    // トークンの検証
    const oauth2Endpoint = 'https://www.googleapis.com/oauth2/v3/tokeninfo';
    const accessToken = params.get('access_token');

    return fetch(`${oauth2Endpoint}?access_token=${accessToken}`, {
        method: 'post'
    }).then(response => {
        if (response.ok) {
            return response.json();
        } else {
            return response.json().then(json => { throw new Error(json.error) });
        }
    }).then(json => {
        // audの確認
        const aud = json.aud;
        if (aud !== gotasks.clientId) throw new Error('aud不一致');

        // scopeの確認
        const scope = json.scope;
        if (scope !== gotasks.scope) throw new Error('scope不一致');

        // 検証に問題がなければトークンを格納
        window.sessionStorage.setItem('token', accessToken);
        // あと有効期限も格納
        const dt = new Date();
        dt.setSeconds(dt.getSeconds() + new Number(json.expires_in));
        window.sessionStorage.setItem('token-expiration', dt.getTime());
        console.log('get token!!');
    });
};

/**
 * fetch API の共通エラーハンドリング
 */
gotasks.handleFetchErrors = response => {
    if (response.ok) {
        // empty response body だと json() がエラーになるので
        console.log(response.status);
        return response.status === 204 ? {} : response.json();
    } else {
        return response.json().then(json => {
            console.log(json);
            throw new Error(`${json.error.code}: ${json.error.message}`);
        });
    }
};

/**
 * リトライした処理を管理します
 */
gotasks.observer = {
    listeners: [],
    on(fn) {
        this.listeners.push(fn)
    },
    trigger() {
        const promises = [];
        console.log(this.listeners.length);
        while (this.listeners.length) {
            const fn = this.listeners.shift();
            if (typeof fn === 'function') {
                promises.push(fn());
            }
        }
        console.log(this.listeners.length);
        return promises;
    }
};

/**
 * タスク名を取得する
 */
gotasks.getTaskListName = tasklist => {
    // Partial response 用
    const params = new URLSearchParams();
    params.append('fields', 'title');

    return fetch(`https://www.googleapis.com/tasks/v1/users/@me/lists/${tasklist}?${params}`, {
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`
        }
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.getTaskListName(tasklist) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-list-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        return json;
    });
};

/**
 * タスクリストの一覧を取得する
 * 100件を超えることはそうそうないと思うのでページングは省略
 */
gotasks.getTaskLists = () => {
    // Partial response 用
    const params = new URLSearchParams();
    params.append('fields', 'items(id,title)');

    return fetch(`https://www.googleapis.com/tasks/v1/users/@me/lists?${params}`, {
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`
        }
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.getTaskLists() });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-list-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        return json;
    });
};

/**
 * タスク一覧を取得する
 */
gotasks.getTasks = (tasklist, nextPageToken) => {
    // リクエストパラメータの準備
    const params = new URLSearchParams();
    params.append('fields', 'nextPageToken,items(id,etag,title,notes,due,completed)');
    if (nextPageToken) {
        params.append('pageToken', nextPageToken);
    }

    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/tasks?${params.toString()}`, {
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`
        }
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.getTasks(tasklist) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-list-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        // TODO 次ページがあった場合は？
        console.log(json);
        return json;
    });
};

/**
 * タスクの詳細を取得します。
 * @param {string} tasklist - Task list identifier
 * @param {string} task - Task identifier
 */
gotasks.getTaskDetail = (tasklist, task) => {
    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/tasks/${task}`, {
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`
        }
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.getTaskDetail(tasklist, task) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-get-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        console.log(json);
        return json;
    });
};

/**
 * タスクを追加する
 */
gotasks.addtask = (tasklist, data) => {
    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/tasks`, {
        method: 'POST',
        mode: 'cors',
        headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`,
        },
        body: JSON.stringify(data)
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.addtask(tasklist, data) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-post-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        console.log(json);
        return json;
    });
};

/**
 * タスクの内容を更新する
 */
gotasks.updateTask = (tasklist, id, etag, data) => {
    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/tasks/${id}`, {
        method: 'PATCH',
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`,
            'content-type': 'application/json',
            'If-Match': etag
        },
        body: JSON.stringify(data)
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.updateTask(tasklist, id, etag, data) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-post-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        console.log(json);
        return json;
    });
};

/**
 * タスクの完了/未完了を更新
 */
gotasks.updateCompleted = (tasklist, id, etag, checked) => {
    const json = {};
    if (checked) {
        json.status = 'completed';
    } else {
        json.completed = null;
        json.status = 'needsAction';
    }

    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/tasks/${id}`, {
        method: 'PATCH',
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`,
            'content-type': 'application/json',
            'If-Match': etag
        },
        body: JSON.stringify(json)
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.updateCompleted(tasklist, id, etag, checked) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-post-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        console.log(json);
        return json;
    });
};

/**
 * 完了したタスクを削除する
 */
gotasks.clearCompletedTasks = tasklist => {
    return fetch(`https://www.googleapis.com/tasks/v1/lists/${tasklist}/clear`, {
        method: 'POST',
        mode: 'cors',
        headers: {
            Authorization: `Bearer ${window.sessionStorage.getItem('token')}`
        }
    }).then(response => {
        if (response.status === 401) {
            // 401の場合はおそらくアクセストークンが期限切れなので再取得してリトライする
            gotasks.refresh(() => { return gotasks.clearCompletedTasks(tasklist) });
            // このリクエスト自体はエラーにしておく
            return Promise.reject(new Error('tasks-post-api returned 401'));
        }

        // それ以外は通常通り
        return gotasks.handleFetchErrors(response);
    }).then(json => {
        return json;
    }).catch(err => {
        console.log(err);
        throw new Error('clear error');
    });
}

/**
 * メイン（シェル）を表示する
 */
gotasks.viewMain = () => {
    const t = document.querySelector('#mainContents');
    const clone = document.importNode(t.content, true);

    clone.querySelector('button.reload').onclick = reload;
    clone.querySelector('button.add').onclick = add;
    clone.querySelector('button.setting').onclick = setting;
    clone.querySelector('button.clear').onclick = clear;

    const tasklist = gotasks.taskLists.selected;
    const taskListName = gotasks.getTaskListName(tasklist);
    const tasks = gotasks.viewTask(clone);

    Promise.all([taskListName, tasks]).then(result => {
        clone.querySelector('h1').textContent = result[0].title;

        const main = document.querySelector('.main-contents');
        main.innerHTML = '';
        main.appendChild(clone);
    }).catch(err => {
        throw new Error(err);
    });

    // 更新ボタンのイベント
    function reload(event) {
        window.location.reload(true);
    }

    // タスク追加ボタンのイベント
    function add(event) {
        gotasks.router.navigate('#taskDetail');
    }

    // 設定ボタンのイベント
    function setting(event) {
        gotasks.router.navigate('#setting');
    }

    // 完了したタスクを削除ボタンのイベント
    function clear(event) {
        gotasks.clearCompletedTasks(tasklist).then(() => {
            gotasks.router.navigate('#tasks');
        });
    }
};

/**
 * タスクの一覧を表示します
 */
gotasks.viewTask = async element => {

    // すべてのタスクを取得する
    const tasklist = gotasks.taskLists.selected;
    const items = await (async function getAllTasks(nextPageToken) {
        const data = await gotasks.getTasks(tasklist, nextPageToken).catch(err => { throw new Error(err) });
        if (data.nextPageToken) {
            // 次のページがあったらさらに読み込む
            const items = await getAllTasks(data.nextPageToken);
            // 今のページに次のページ内容をマージ
            return data.items.concat(items);
        } else {
            return data.items;
        }
    })();
    console.log(items);

    // 期限ごとにタスクを分割 {due: [title, title,...]}
    const source = {};

    items.forEach(task => {
        const due = task.due || '期限なし';
        if (!(due in source)) {
            source[due] = [];
        }
        source[due].push(task);
    });

    // 期限ごとにタスクを表示する部品を生成
    const t = document.querySelector('#task');
    const docfrag = document.createDocumentFragment();

    // 期限でソートして表示したい
    Object.keys(source).sort().forEach(key => {
        const clone = document.importNode(t.content, true);

        const ul = clone.querySelector('ul');
        source[key].forEach(taskObj => {
            const li = document.createElement('li');
            const a = document.createElement('a');

            // タスクをつくる
            a.textContent = taskObj.title;
            a.setAttribute('href', '#detail');
            a.setAttribute('data-id', taskObj.id);
            a.addEventListener('click', taskClick, false);

            const check = document.createElement('input');
            check.setAttribute('type', 'checkbox');
            check.setAttribute('name', taskObj.id);
            check.setAttribute('data-etag', taskObj.etag);
            check.addEventListener('click', taskCompleted, false);
            if (taskObj.completed) {
                check.checked = true;
            }

            // リストに入れる
            li.appendChild(check);
            li.appendChild(a);
            ul.appendChild(li);
        });

        // 期限を見出しにする
        const h2 = clone.querySelector('h2');
        h2.textContent = key;

        docfrag.appendChild(clone);
    });

    // 画面へ表示
    if (items.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'タスクはありません！';
        docfrag.appendChild(p);
    }
    element.querySelector('main').append(docfrag);

    // タスクの詳細を表示するイベント
    function taskClick(event) {
        event.preventDefault();
        // TODO この辺 try-catch が適当なのでは
        //gotasks.viewTaskDetail('@default', event.currentTarget.dataset.id).catch(err => { throw new Error(err) });
        gotasks.router.navigate(`#taskDetail-${event.currentTarget.dataset.id}`);
    }

    // タスクを完了するイベント
    function taskCompleted(event) {
        const tasklist = gotasks.taskLists.selected;
        const etag = event.target.dataset.etag;
        const checked = event.target.checked;
        const id = event.target.name;
        gotasks.updateCompleted(tasklist, id, etag, checked).then(json => {
            document.querySelector(`input[name="${json.id}"]`).dataset.etag = json.etag;
        });
    }
};

/**
 * タスクの詳細を表示します。
 */
gotasks.viewTaskDetail = async task => {
    const t = document.querySelector('#taskDetail');
    const clone = document.importNode(t.content, true);

    // Task identifierがあれば詳細を取得して表示する
    if (task) {
        const tasklist = gotasks.taskLists.selected;
        const data = await gotasks.getTaskDetail(tasklist, task).catch(err => { throw new Error(err) });
        clone.querySelector('input[name="taskName"]').value = data.title || '';
        clone.querySelector('input[name="dueDate"]').value = data.due ? new Date(data.due).toISOString().split('T')[0] : '';
        clone.querySelector('textarea[name="notes"]').value = data.notes || '';
        clone.querySelector('input[name="etag"]').value = data.etag;
    }

    clone.querySelector('form').onsubmit = save;
    clone.querySelector('button.cancel').onclick = cancel;

    // 表示内容を入れ替え
    const mainContents = document.querySelector('.main-contents');
    mainContents.appendChild(clone);

    // 保存ボタンのイベント
    function save(event) {
        event.preventDefault();
        //const form = new FormData(event.target);
        const form = event.target;
        const title = form.querySelector('input[name="taskName"]').value || null;
        const notes = form.querySelector('textarea[name="notes"]').value || null;
        const dueDate = form.querySelector('input[name="dueDate"]').value;
        const due = dueDate ? new Date(dueDate).toISOString() : null;

        if (task) {
            // タスクを更新
            const tasklist = gotasks.taskLists.selected;
            const etag = form.querySelector('input[name="etag"]').value;
            gotasks.updateTask(tasklist, task, etag, { title, due, notes }).then(gotasks.router.navigate('#'));
        } else {
            // タスクを新規追加
            const json = {};
            title && (json.title = title);
            due && (json.due = due);
            notes && (json.notes = notes);

            gotasks.addtask(gotasks.taskLists.selected, json).then(gotasks.router.navigate('#'));
        }
    }

    // キャンセルボタンのイベント
    function cancel(event) {
        gotasks.router.navigate('#');
    }
};

/**
 * 設定画面の表示
 */
gotasks.viewSetting = async () => {
    const t = document.querySelector('#setting');
    const clone = document.importNode(t.content, true);

    // タスクリストの一覧をつくる
    const select = clone.querySelector('select');
    const lists = await gotasks.getTaskLists();
    lists.items.forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title;
        if (gotasks.taskLists.selected === item.id) {
            option.selected = true;
        }
        select.appendChild(option);
    });
    select.onchange = changeTaskList;

    // ログアウトのボタン
    clone.querySelector('.logout').onclick = logout;

    const mainContents = document.querySelector('.main-contents');
    mainContents.innerHTML = '';
    mainContents.appendChild(clone);

    // タスクリストの選択
    function changeTaskList(event) {
        gotasks.taskLists.selected = event.target.value;
    }

    // ログアウト
    function logout(event) {
        window.localStorage.clear();
        window.sessionStorage.removeItem('token-expiration');
        // TODO トークンをrevoke
        window.sessionStorage.removeItem('token');
        window.location.href = '/';
    }
}

/**
 * ルーターのやつ
 */
gotasks.router = {
    routes: {
        '': gotasks.viewMain,
        '#': gotasks.viewMain,
        '#signin': '',//gotasks,viewSignIn,
        '#tasks': gotasks.viewMain,
        '#taskDetail': gotasks.viewTaskDetail,
        '#setting': gotasks.viewSetting
    },
    showView(hash) {
        // routesから取得してなんかする
        const hashParts = hash.split('-');
        const viewFn = this.routes[hashParts[0]];
        if (viewFn) {
            document.querySelector('.main-contents').innerHTML = '';
            viewFn(hashParts[1]);
        }
    },
    navigate(hash) {
        if (hash !== '') {
            const current = window.location.href;
            const next = window.location.href.replace(/#(.*)$/, '') + `${hash}`;

            window.location.href = next;

            // ハッシュが変わらなかった場合は強制的にイベントを発生させる
            current == next && window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
    }
};

/**
 * アクセストークンの管理
 */
gotasks.token = {

};

/**
 * 選択中のタスクリスト管理
 */
gotasks.taskLists = {
    _key: 'selectedTaskLists',
    get selected() {
        return window.localStorage.getItem(this._key) || '@default';
    },
    set selected(id) {
        window.localStorage.setItem(this._key, id);
    }
};

/**
 * 初期処理
 */
gotasks.init = () => {
    // Sign-Inボタンに、クリックするとアクセストークンをもらう処理を登録
    document.getElementById('sign-in').addEventListener('click', gotasks.signin, false);

    // もらったアクセストークンを受け取ったときの処理を登録
    window.addEventListener('message', gotasks.receiveMessage, false);

    // るーたーのやつ
    window.addEventListener('hashchange', event => {
        gotasks.router.showView(window.location.hash);
    });

    // 初回アクセスでなければアクセストークンを更新してタスク一覧を表示する
    // TODO ログアウトがないですね
    if (window.localStorage.getItem('logged-in')) {
        // もしトークンが期限切れなら再取得して表示する
        const expiration = window.sessionStorage.getItem('token-expiration');
        if (Date.now() > expiration) {
            gotasks.refresh(() => { return gotasks.router.showView(window.location.hash) });
        } else {
            gotasks.router.showView(window.location.hash);
        }
    }
};

export default gotasks;
