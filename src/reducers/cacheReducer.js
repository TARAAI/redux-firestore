import produce, { createDraft, finishDraft } from 'immer';
import debug from 'debug';
import {
  set,
  unset,
  filter,
  flow,
  orderBy,
  take,
  map,
  partialRight,
  pick,
  compact,
  zip,
  setWith,
  extend,
  isFunction,
  findIndex,
  isMatch,
  get,
  isEqual,
  takeRight,
} from 'lodash';
import { actionTypes } from '../constants';
import { getBaseQueryName } from '../utils/query';
import mark from '../utils/profiling';

const info = debug('rrf:cache');

/**
 * @typedef {object & Object.<string, RRFQuery>} CacheState
 * Cache state is a synchronous, in-memory fragment of Firestore. The primary
 * goal is to provide instant, synchronous data mutations. The key use case to consider
 * is when React has a drag and drop interface but the data change requires a
 * transaction which must round-trip to the server before it's reflected in Redux.
 * @property {object.<FirestorePath, object<FirestoreDocumentId, Doc>>}  database
 * Store in-memory documents returned from firestore, with no modifications.
 * @property {object.<FirestorePath, object<FirestoreDocumentId, ParitalDoc>>}  databaseOverrides
 * Store document fragments that are in-flight to be persisted to firestore.
 */

/**
 * @typedef {string} FirestorePath
 * @typedef {string} FirestoreDocumentId
 * @typedef {object} FirestoreDocument
 * @typedef {{ id: FirestoreDocumentId, path: FirestorePath } & FirestoreDocument} Doc
 * @typedef {{ id: FirestoreDocumentId, path: FirestorePath } & ?FirestoreDocument} ParitalDoc
 * @typedef {Array.<string>} Populates - [field_name, firestore_path_to_collection, new_field_name]
 * @typedef {Array.<string>} Fields - document fields to include for the result
 * @typedef {Array<*> & { 0: FirestorePath, 1: FirestoreDocumentId, length: 2 }} OrderedTuple
 * @property
 */

/**
 * @typedef {object & {fields: Fields, populates: Populates, docs: Doc[], ordered: OrderedTuple}} RRFQuery
 * @property {string|object} collection - React Redux Firestore collection path
 * @property {?string} storeAs - alias to store the query results
 * @property {?Array.<string>} where - Firestore Query tuple
 * @property {?Array.<string>} orderBy - Firestore Query orderBy
 * @property {?Fields} fields - Optional fields to pick for each document
 * @property {?Populates} populates - Optional related docs to include
 * @property {Doc[]} docs - Array of documents that includes the overrides,
 * field picks and populate merges
 * @property {OrderedTuple} ordered - Tuple of [path, doc_id] results returned
 * from firestore. Overrides do NOT mutate this field. All reordering
 * comes from running the filter & orderBy xForms.
 */

/**
 * @typedef {object} Mutation_v1
 * @property {string} collection - firestore path into the parent collection
 * @property {string} doc - firestore document id
 * @property {object} data - document to be saved
 */

/**
 * @typedef {object} Mutation_v2
 * The full document to be saved in firestore with 2 additional properties
 * @property {string} path - firestore path into the parent collection
 * @property {string} id - firestore document id
 * ...rest - the rest of the data will be saved to as the firestore doc
 */

/**
 * @typedef {Mutation_v1 | Mutation_v2} Write
 * @typedef {Array<Mutation_v1 | Mutation_v2>} Batch
 */

/**
 * @typedef {object} Transaction
 * @property {object.<ReadKey, RRFQuery>} reads - Object of read keys and queries
 * @property {Function[]} writes - Array of function that take rekyKey results and return writes
 */

/**
 * @typedef MutateAction_v1
 * @property {Write | Batch | Transaction} payload - mutation payload
 * @property {object} meta
 */

const isTimestamp = (a) => a instanceof Object && a.seconds !== undefined;

const PROCESSES = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  'array-contains': (a, b) => a.includes(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  'array-contains-any': (a, b) => b.some((b1) => a.includes(b1)),
  'not-in': (a, b) => !b.includes(a),
  '*': () => true,
};

const PROCESSES_TIMESTAMP = {
  '<': (a, b) =>
    a.seconds < b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds < b.nanoseconds),
  '<=': (a, b) =>
    a.seconds < b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds <= b.nanoseconds),
  '==': (a, b) => a.seconds === b.seconds && a.nanoseconds === b.nanoseconds,
  '!=': (a, b) => a.seconds !== b.seconds || a.nanoseconds !== b.nanoseconds,
  '>=': (a, b) =>
    a.seconds > b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds >= b.nanoseconds),
  '>': (a, b) =>
    a.seconds > b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds),
  'array-contains': (a, b) => a.includes(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  'array-contains-any': (a, b) => b.some((b1) => a.includes(b1)),
  'not-in': (a, b) => !b.includes(a),
  '*': () => true,
};

/**
 * @name getDocumentTransducer
 * @param ids - array of document ids
 * @typedef {Function} xFormDocument - use cache[storeAs].ordered to get
 * documents from cache.database
 * @returns {xFormDocument} - transducer
 */
const getDocumentTransducer = (ids) =>
  partialRight(map, (coll) => ids.map((id) => coll[id]).filter(Boolean));

/**
 * @name getCollectionTransducer
 * @param {string} collection - stirng of the full firestore path for the collection
 * @typedef xFormCollection - return a single collection from the fragment database
 * @returns {xFormCollection} - transducer
 */
const getCollectionTransducer = (collection) =>
  partialRight(map, (state) => state.database[collection]);

/**
 * @name fieldsTransducer
 * @param {Array.<string>} fields - properties of the document to include in the return
 * @typedef {Function} xFormPartialFields - pick selected doc fields to
 * improve React rendering performance
 * @returns {xFormPartialFields} - transducer
 */
const fieldsTransducer = (fields) =>
  partialRight(map, (docs) =>
    docs.map((doc) => pick(doc, ['id', 'path', ...fields])),
  );

/**
 * @name orderTransducer
 * @param {Array.<string>} order - Firestore order property
 * @typedef {Function} xFormOrdering - sort docs bases on criteria from the
 * firestore query
 * @returns {xFormOrdering} - transducer
 */
const orderTransducer = (order) => {
  const isFlat = typeof order[0] === 'string';
  const orders = isFlat ? [order] : order;
  const [fields, direction] = zip(
    ...orders.map(([field, dir]) => [
      (data) => {
        if (typeof data[field] === 'string') return data[field].toLowerCase();
        if (isTimestamp(data[field])) return data[field].seconds;
        return data[field];
      },
      dir || 'asc',
    ]),
  );
  return partialRight(map, (docs) => orderBy(docs, fields, direction));
};

/**
 * @name limitTransducer
 * @param {number} limit - firestore limit number
 * @typedef {Function} xFormLimiter - limit the results to align with
 * limit from the firestore query
 * @returns {xFormLimiter} - transducer
 */
const limitTransducer = ({ limit, endAt, endBefore }) => {
  if (!limit) return null;
  const fromRight = (endAt || endBefore) !== undefined;
  return fromRight
    ? ([arr] = []) => [takeRight(arr, limit)]
    : ([arr] = []) => [take(arr, limit)];
};

/**
 * @name filterTransducers
 * @param {Array.<Array.<string>>} where - Firestore where clauses
 * @typedef {Function} xFormFilter - run the same where cause sent to
 * firestore for all the optimitic overrides
 * @returns {xFormFilter} - transducer
 */
const filterTransducers = (where) => {
  const isFlat = typeof where[0] === 'string';
  const clauses = isFlat ? [where] : where;

  return clauses.map(([field, op, val]) => {
    const fnc = isTimestamp(val)
      ? PROCESSES_TIMESTAMP[op]
      : PROCESSES[op] || (() => true);
    return partialRight(map, (collection) =>
      filter(Object.values(collection || {}), (doc) => {
        if (!doc) return false;
        let value;
        if (field === '__name__') {
          value = doc.id;
        } else if (field.includes('.')) {
          value = field
            .split('.')
            .reduce((obj, subField) => obj && obj[subField], doc);
        } else {
          value = doc[field];
        }

        if (value === undefined) value = null;

        return fnc(value, val);
      }),
    );
  });
};

/**
 * @name paginateTransducers
 * @param {RRFQuery} query - Firestore query
 * @param {Boolean} isOptimisticWrite - includes optimistic data
 * @typedef {Function} xFormFilter - in optimistic reads and overrides
 * the reducer needs to take all documents and make a best effort to
 * filter down the document based on a cursor.
 * @returns {xFormFilter} - transducer
 */
const paginateTransducers = (query, isOptimisticWrite = false) => {
  const { orderBy: order, startAt, startAfter, endAt, endBefore, via } = query;
  const isOptimisticRead = via === undefined;
  if (!(isOptimisticRead || isOptimisticWrite)) return null;

  const start = startAt || startAfter;
  const end = endAt || endBefore;
  const isAfter = startAfter !== undefined;
  const isBefore = endBefore !== undefined;
  if (start === undefined && end === undefined) return null;

  const isFlat = typeof order[0] === 'string';
  const orders = isFlat ? [order] : order;
  const isPaginateMatched = (doc, at, before = false, after = false) =>
    orders.find(([field, sort = 'asc'], idx) => {
      const value = Array.isArray(at) ? at[idx] : at;
      if (value === undefined) return false;

      // TODO: add support for document refs
      const proc = isTimestamp(doc[field]) ? PROCESSES_TIMESTAMP : PROCESSES;
      let compare = process['=='];
      if (startAt || endAt) compare = proc[sort === 'desc' ? '<=' : '>='];
      if (startAfter || endBefore) compare = proc[sort === 'desc' ? '<' : '>'];

      const isMatched = compare(doc[field], value);
      if (isMatched) {
        return true;
      }
    }) !== undefined;

  return partialRight(map, (docs) => {
    const results = [];
    let started = start === undefined;

    docs.forEach((doc) => {
      if (!started && start) {
        if (isPaginateMatched(doc, start, undefined, isAfter)) {
          started = true;
        }
      }

      if (started && end) {
        if (isPaginateMatched(doc, end, isBefore, undefined)) {
          started = false;
        }
      }

      if (started) {
        results.push(doc);
      }
    });

    return results;
  });
};

/**
 * @name populateTransducer
 * @param {string} collection - path to collection in Firestore
 * @param {Array.<Populates>} populates - array of populates
 * @typedef {Function} xFormPopulate - run the populate when a firestore listener
 * triggers instead of on a case by case basis in the selector
 * @returns {xFormPopulate}
 */
const populateTransducer = (collection, populates) =>
  partialRight(map, (state) => {
    // Notice: by it's nature populate is O(2^n)/exponential.
    // In large data sets, every populate will add substantial time.

    const done = mark(`populate.${collection}`);

    // pre-grab collection and remove empty populations
    const lookups = (Array.isArray(populates[0]) ? populates : [populates])
      .map((tuple) => [tuple[0], state.database[tuple[1]], tuple[2]])
      .filter(
        (tuple) =>
          tuple[1] !== undefined && Object.keys(tuple[1] || []).length > 0,
      );

    const raw = state.database[collection] || {};
    const ids = Object.keys(raw);

    const collectionById = ids.reduce((draft, id) => {
      lookups.forEach(([field, siblings, destination]) => {
        const fields = field.split('.');
        const childID = fields.reduce(
          (res, prop) => res && res[prop],
          draft[id],
        );

        if (Array.isArray(childID)) {
          // eslint-disable-next-line no-param-reassign
          draft[id][destination] = childID.map((childId) => {
            const child = siblings[childId];
            return child || undefined;
          });
        }
        const child = siblings[childID];
        if (child) {
          // eslint-disable-next-line no-param-reassign
          draft[id][destination] = child;
        }
      });
      return draft;
    }, createDraft(raw));

    done();

    return { database: { [collection]: finishDraft(collectionById) } };
  });

/**
 * @name overridesTransducers
 * @param {object} overrides - mirrored structure to database but only with updates
 * @param {string} collection - path to firestore collection
 * @typedef {Function} xFormOverrides - takes synchronous, in-memory change
 * requests and applies them to the in-memory database
 * @returns {xFormOverrides}
 */
const overridesTransducers = (overrides, collection) => {
  const partials = (overrides && overrides[collection]) || {};
  return Object.keys(partials).map((docId) =>
    partialRight(map, (coll) =>
      partials[docId] === null
        ? unset(coll, docId)
        : set(coll, [docId], extend({}, coll[docId], partials[docId])),
    ),
  );
};

/**
 * @name buildTransducer
 * Convert the query to a transducer for the query results
 * @param {?CacheState.databaseOverrides} overrides -
 * @param {RRFQuery} query - query used to get data from firestore
 * @returns {Function} - Transducer will return a modifed array of documents
 */
function buildTransducer(overrides, query) {
  const {
    collection,
    where,
    orderBy: order,
    ordered,
    fields,
    populates,
  } = query;

  const isOptimistic =
    ordered === undefined ||
    Object.keys((overrides || {})[collection] || {}).length > 0;

  const xfPopulate = !populates
    ? null
    : populateTransducer(collection, populates);
  const xfGetCollection = getCollectionTransducer(collection);
  const xfGetDoc = getDocumentTransducer((ordered || []).map(([__, id]) => id));
  const xfFields = !fields ? null : fieldsTransducer(fields);

  const xfApplyOverrides = !isOptimistic
    ? null
    : overridesTransducers(overrides || { [collection]: [] }, collection);
  const xfFilter =
    !isOptimistic || filterTransducers(!where ? ['', '*', ''] : where);
  const xfOrder = !isOptimistic || !order ? null : orderTransducer(order);
  const xfPaginate = paginateTransducers(query, isOptimistic);
  const xfLimit = limitTransducer(query);

  if (!isOptimistic) {
    return flow(
      compact([
        xfPopulate,
        xfGetCollection,
        xfGetDoc,
        xfOrder,
        xfPaginate,
        xfLimit,
        xfFields,
      ]),
    );
  }

  return flow(
    compact([
      xfPopulate,
      xfGetCollection,
      partialRight(map, (db) => createDraft(db || {})),
      ...xfApplyOverrides,
      partialRight(map, (db) => finishDraft(db)),
      ...xfFilter,
      xfOrder,
      xfPaginate,
      xfLimit,
      xfFields,
    ]),
  );
}

/**
 * @name selectDocuments
 * Merge overrides with database cache and resort/filter when needed
 * @param {object} reducerState - optimitic redux state
 * @param {RRFQuery} query - query from the meta field of the action
 * @returns {object} updated reducerState
 */
function selectDocuments(reducerState, query) {
  const transduce = buildTransducer(reducerState.databaseOverrides, query);
  return transduce([reducerState])[0];
}

/**
 * @name reprocessQueries
 * Rerun all queries that contain the same collection
 * @param {object} draft - reducer state
 * @param {string} path - path to rerun queries for
 */
function reprocessQueries(draft, path) {
  const done = mark(`reprocess.${path}`);
  const queries = [];

  const paths = Array.isArray(path) ? path : [path];
  Object.keys(draft).forEach((key) => {
    if (['database', 'databaseOverrides'].includes(key)) return;
    const { collection, populates = [] } = draft[key];
    const pops = Array.isArray(populates[0]) ? populates : [populates];
    const collections = pops.map(([__, coll]) => coll).concat(collection);
    if (!collections.some((coll) => paths.includes(coll))) {
      return;
    }
    queries.push(key);

    const docs = selectDocuments(draft, draft[key]);
    const ordered = docs.map(({ id, path: _path }) => [_path, id]);
    const isInitialLoad = draft[key].via === 'memory' && docs.length === 0;
    set(draft, [key, 'docs'], isInitialLoad ? undefined : docs);
    set(draft, [key, 'ordered'], ordered);
  });

  if (info.enabled) {
    /* istanbul ignore next */
    const overrides = JSON.parse(JSON.stringify(draft.databaseOverrides || {}));
    /* istanbul ignore next */
    info(
      `reprocess ${path} (${queries.length} queries) with overrides`,
      overrides,
    );
  }

  done();
}

// --- Mutate support ---

/**
 * Not a Mutate, just an array
 * @param {Array} arr
 * @returns Null | Array
 */
const primaryValue = (arr) =>
  typeof arr[0] === 'string' && arr[0].indexOf('::') === 0 ? null : arr;

/**
 * Mutate Nested Object
 * @param {*} obj - data
 * @param {*} key - nested key path
 * @param {*} val - value to be set
 * @returns Null | object
 */
const nestedMap = (obj, key, val) => {
  // eslint-disable-next-line no-param-reassign
  delete obj[key];
  const fields = key.split('.');
  fields.reduce((deep, field, idx) => {
    // eslint-disable-next-line no-param-reassign
    if (deep[field] === undefined) deep[field] = {};
    // eslint-disable-next-line no-param-reassign
    if (idx === fields.length - 1) deep[field] = val;
    return deep[field];
  }, obj);
  return obj;
};

const arrayUnion = (key, val, cached) =>
  key !== '::arrayUnion' ? null : (cached() || []).concat([val]);

const arrayRemove = (key, val, cached) =>
  key === '::arrayRemove' && (cached() || []).filter((item) => item !== val);

const increment = (key, val, cached) =>
  key === '::increment' && typeof val === 'number' && (cached() || 0) + val;

const serverTimestamp = (key) => key === '::serverTimestamp' && new Date();

/**
 * Process Mutation to a vanilla JSON
 * @param {*} mutation - payload mutation
 * @param {Function} cached - function that returns in-memory cached instance
 * @returns
 */
function atomize(mutation, cached) {
  return Object.keys(mutation).reduce((data, key) => {
    const val = data[key];
    if (key.includes('.')) {
      nestedMap(data, key, val);
    } else if (Array.isArray(val) && val.length > 0) {
      // eslint-disable-next-line no-param-reassign
      data[key] =
        primaryValue(val) ||
        serverTimestamp(val[0]) ||
        arrayUnion(val[0], val[1], () => cached(key)) ||
        arrayRemove(val[0], val[1], () => cached(key)) ||
        increment(val[0], val[1], () => cached(key));
    }
    return data;
  }, JSON.parse(JSON.stringify(mutation)));
}
/**
 * Translate mutation to a set of database overrides
 * @param {MutateAction} action - Standard Redux action
 * @param {object.<FirestorePath, object<FirestoreDocumentId, Doc>>} db - in-memory database
 * @returns Array<object<FirestoreDocumentId, Doc>>
 */
function translateMutationToOverrides({ payload }, db) {
  // turn everything to a write
  let { reads, writes } = payload.data || {};
  if (!writes) {
    writes = Array.isArray(payload.data) ? payload.data : [payload.data];
  } else if (!Array.isArray(writes)) {
    writes = [writes];
  }

  // grab reads sync from in-memory database
  let reader = {};
  if (reads) {
    reader = Object.keys(reads).reduce((result, key) => {
      const { collection, doc } = result[key];
      if (!doc) {
        throw new Error("Firestore Transactions don't support query lookups.");
      }
      const coll = db[collection] || {};
      return {
        ...result,
        [key]: coll[doc],
      };
    }, reads);
  }

  const overrides = writes
    .map((writer) => (isFunction(writer) ? writer(reader) : writer))
    .map(({ collection, path, doc, id, data, ...rest }) => ({
      collection: path || collection,
      doc: id || doc,
      data: atomize(data || rest, (key) => {
        const overrides = Object.keys(db).length > 0 ? db : {};
        const coll = overrides[path || collection] || {};
        return (coll[id || doc] || {})[key];
      }),
    }));

  return overrides;
}

/**
 * @param {object} draft - reduce state
 * @param {string} action.path - path of the parent collection
 * @param {string} action.id - document id
 * @param {object} action.data - data in the payload
 */
function cleanOverride(draft, { path, id, data }) {
  if (!path || !id) return;

  const override = get(draft, ['databaseOverrides', path, id], false);

  if (!override || (data && !isMatch(data, override))) return;

  const keys = Object.keys(override);
  const props = !data
    ? keys
    : keys.filter((key) => {
        // manually check draft proxy values
        const current = get(data, key);
        const optimistic = override[key];

        if (current === null || current === undefined) {
          return current === optimistic;
        }
        if (Array.isArray(current)) {
          return current.every((val, idx) => val === optimistic[idx]);
        }
        if (typeof current === 'object') {
          return Object.keys(current).every(
            (key) => current[key] === optimistic[key],
          );
        }
        return isEqual(data[key], override[key]);
      });

  const isDone = props.length === Object.keys(override).length;
  const isEmpty =
    isDone && Object.keys(draft.databaseOverrides[path] || {}).length === 1;

  if (isEmpty) {
    unset(draft, ['databaseOverrides', path]);
  } else if (isDone) {
    unset(draft, ['databaseOverrides', path, id]);
  } else {
    props.forEach((prop) => {
      unset(draft, ['databaseOverrides', path, id, prop]);
    });
  }
}

// --- action type handlers ---

const initialize = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.${action.type.replace(/(@@.+\/)/, '')}`, key);
    if (!draft.database) {
      set(draft, ['database'], {});
      set(draft, ['databaseOverrides'], {});
    }

    const via = {
      undefined: 'memory',
      true: 'cache',
      false: 'server',
    }[action.payload.fromCache];

    if (action.payload.data) {
      Object.keys(action.payload.data).forEach((id) => {
        setWith(draft, ['database', path, id], action.payload.data[id], Object);

        cleanOverride(draft, { path, id, data: action.payload.data[id] });
      });
    }

    // set the query
    const ordered = (
      action.payload.ordered || selectDocuments(draft, action.meta)
    ).map(({ path, id }) => [path, id]);

    set(draft, [action.meta.storeAs], {
      ordered,
      ...action.meta,
      via,
    });

    // append docs field to query
    reprocessQueries(draft, path);

    done();
    return draft;
  });

const conclude = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.UNSET_LISTENER`, key);
    if (draft[key]) {
      if (!action.payload.preserveCache) {
        // remove query
        unset(draft, [key]);
      }

      reprocessQueries(draft, path);
    }

    done();
    return draft;
  });

const modify = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.DOCUMENT_MODIFIED`, key);
    setWith(
      draft,
      ['database', path, action.meta.doc],
      action.payload.data,
      Object,
    );

    cleanOverride(draft, {
      path,
      id: action.meta.doc,
      data: action.payload.data,
    });

    const { payload } = action;
    const { oldIndex = 0, newIndex = 0 } = payload.ordered || {};

    if (newIndex !== oldIndex) {
      const tuple =
        (payload.data && [payload.data.path, payload.data.id]) ||
        draft[key].ordered[oldIndex];

      const { ordered } = draft[key] || { ordered: [] };
      const idx = findIndex(ordered, [1, action.meta.doc]);

      const isIndexChange = idx !== -1;
      const isAddition = oldIndex === -1 || isIndexChange;
      const isRemoval = newIndex === -1 || isIndexChange;

      if (isRemoval && idx > -1) {
        ordered.splice(idx, 0);
      } else if (isAddition) {
        ordered.splice(newIndex, 0, tuple);
      }

      set(draft, [key, 'ordered'], ordered);
    }

    // reprocessing unifies any order changes from firestore
    if (action.meta.reprocess !== false) {
      reprocessQueries(draft, path);
    }

    done();
    return draft;
  });

const failure = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.MUTATE_FAILURE`, key);
    // All failures remove overrides
    if (action.payload.data || action.payload.args) {
      const write = action.payload.data
        ? [{ writes: [action.payload.data] }]
        : action.payload.args;
      const allPaths = write.reduce(
        (results, { writes }) => [
          ...results,
          ...writes.map(({ collection, path: _path, doc, id }) => {
            info('remove override', `${collection}/${doc}`);

            // don't send data to ensure document override is deleted
            cleanOverride(draft, { path: _path || collection, id: id || doc });

            return path || collection;
          }),
        ],
        [],
      );

      const uniquePaths = Array.from(new Set(allPaths));
      if (uniquePaths.length > 0) {
        reprocessQueries(draft, uniquePaths);
      }
    }

    done();
    return draft;
  });

const deletion = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.DELETE_SUCCESS`, key);
    if (draft.database && draft.database[path]) {
      unset(draft, ['database', path, action.meta.doc]);
    }

    cleanOverride(draft, { path, id: action.meta.doc });

    // remove document id from ordered index
    if (draft[key] && draft[key].ordered) {
      const idx = findIndex(draft[key].ordered, [1, action.meta.doc]);
      draft[key].ordered.splice(idx, 1);
    }

    // reprocess
    reprocessQueries(draft, path);

    done();
    return draft;
  });

const remove = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.DOCUMENT_REMOVED`, key);
    cleanOverride(draft, {
      path,
      id: action.meta.doc,
      data: action.payload.data,
    });

    // remove document id from ordered index
    if (draft[key] && draft[key].ordered) {
      const idx = findIndex(draft[key].ordered, [1, action.meta.doc]);
      const wasNotAlreadyRemoved = idx !== -1;
      if (wasNotAlreadyRemoved) {
        draft[key].ordered.splice(idx, 1);
      }
    }

    // reprocess
    reprocessQueries(draft, path);

    done();
    return draft;
  });

const optimistic = (state, { action, key, path }) =>
  produce(state, (draft) => {
    setWith(
      draft,
      ['databaseOverrides', path, action.meta.doc],
      action.payload.data,
      Object,
    );

    reprocessQueries(draft, path);
    return draft;
  });

const reset = (state, { action, key, path }) =>
  produce(state, (draft) => {
    cleanOverride(draft, { path, id: action.meta.doc });

    reprocessQueries(draft, path);
    return draft;
  });

const mutation = (state, { action, key, path }) =>
  produce(state, (draft) => {
    const done = mark(`cache.MUTATE_START`, key);
    if (action.payload && action.payload.data) {
      const optimisiticUpdates =
        translateMutationToOverrides(action, draft.database) || [];

      optimisiticUpdates.forEach(({ collection, doc, data }) => {
        info('overriding', `${collection}/${doc}`, data);
        setWith(draft, ['databaseOverrides', collection, doc], data, Object);
      });

      const updatePaths = [
        ...new Set(optimisiticUpdates.map(({ collection }) => collection)),
      ];
      updatePaths.forEach((path) => {
        reprocessQueries(draft, path);
      });
    }

    done();
    return draft;
  });

const HANDLERS = {
  [actionTypes.SET_LISTENER]: initialize,
  [actionTypes.LISTENER_RESPONSE]: initialize,
  [actionTypes.GET_SUCCESS]: initialize,
  [actionTypes.UNSET_LISTENER]: conclude,
  [actionTypes.DOCUMENT_ADDED]: modify,
  [actionTypes.DOCUMENT_MODIFIED]: modify,
  [actionTypes.DELETE_SUCCESS]: deletion,
  [actionTypes.DOCUMENT_REMOVED]: remove,
  [actionTypes.OPTIMISTIC_ADDED]: optimistic,
  [actionTypes.OPTIMISTIC_MODIFIED]: optimistic,
  [actionTypes.OPTIMISTIC_REMOVED]: reset,
  [actionTypes.MUTATE_FAILURE]: failure,
  [actionTypes.DELETE_FAILURE]: failure,
  [actionTypes.UPDATE_FAILURE]: failure,
  [actionTypes.SET_FAILURE]: failure,
  [actionTypes.ADD_FAILURE]: failure,
  [actionTypes.MUTATE_START]: mutation,
};

/**
 * @name cacheReducer
 * Reducer for in-memory database
 * @param {object} [state={}] - Current listenersById redux state
 * @param {object} action - Object containing the action that was dispatched
 * @param {string} action.type - Type of action that was dispatched
 * @returns {object} Queries state
 */
export default function cacheReducer(state = {}, action) {
  const fnc = HANDLERS[action.type];
  if (!fnc) return state;

  const key =
    !action.meta || !action.meta.collection
      ? null
      : action.meta.storeAs || getBaseQueryName(action.meta);
  const path = !action.meta ? null : action.meta.collection;

  return fnc(state, { action, key, path });
}
