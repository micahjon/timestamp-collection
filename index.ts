export type EntryValue<DataType> = [timestamp: number, data: DataType];
export type Entries<DataType> = {
  [key: string]: EntryValue<DataType>;
};
export type Updates<DataType> = { 
  entries: Entries<DataType>,
  deletedKeys: Record<string, number> 
};
export type EntriesHashFunction = (arg0: string) => string;
export type ValidationFunction = (key: string, data: any) => boolean;
export type ComputedPropertyFunction<DataType, ReturnType> = (
  entries: Entries<DataType>
) => ReturnType;
export type ComputedPropertiesDefinition<DataType> = Record<
  string,
  ComputedPropertyFunction<DataType, any>
>;

export default class Collection<DataType> {
  private entries!: Entries<DataType>;
  private deletedKeys!: Record<string, number>;
  private updates!: Updates<DataType>;
  private cachedHash!: string;
  private cachedComputedProperties: Map<ComputedPropertyFunction<DataType, any>, any>;
  private hashFunction: EntriesHashFunction;
  private validationFunction?: ValidationFunction;
  private subscribers: Function[];
  private defaultValue?: DataType;

  constructor({
    hashFunction,
    validateEntry,
    defaultValue,
  }: {
    hashFunction?: EntriesHashFunction;
    validateEntry?: ValidationFunction;
    defaultValue?: DataType;
  } = {}) {
    this.entries = {};
    this.deletedKeys = {};
    this.updates = { entries: {}, deletedKeys: {} };
    this.cachedHash = ''; // Empty string if not yet computed
    this.cachedComputedProperties = new Map();
    this.hashFunction = hashFunction || simpleHash;
    this.validationFunction = validateEntry;
    this.subscribers = [];
    this.defaultValue = defaultValue;
  }

  add(
    key: keyof Entries<DataType> & string,
    timestamp?: number,
    data = this.defaultValue
  ) {
    // Validate data (optional, user provides this function)
    if (this.validationFunction && !this.validationFunction(key, data)) {
      throw new Error('Invalid entry');
    }

    if (!isPositiveInteger(timestamp)) timestamp = Date.now();

    const entry: EntryValue<DataType> = [timestamp!, data!];

    // Get timestamp of current entry or of last deletion
    const existingTimestamp = this.entries[key]
      ? this.entries[key][0]
      : this.deletedKeys[key];

    if (existingTimestamp === undefined || timestamp! >= existingTimestamp) {
      this.updateEntryObjects((entries, deletedKeys) => {
        entries[key] = entry;
        delete deletedKeys[key];
      });
      return true;
    }

    // Existing entry is newer than proposed entry's timestamp
    return false;
  }

  remove(key: keyof Entries<DataType> & string, timestamp?: number) {
    if (!isPositiveInteger(timestamp)) timestamp = Date.now();

    if (!this.entries[key] || this.entries[key][0] <= timestamp!) {
      this.updateEntryObjects((entries, deletedKeys) => {
        delete entries[key];
        deletedKeys[key] = timestamp!;
      });
      return true;
    }

    // Existing entry is newer than timestamp
    return false;
  }

  private updateEntryObjects(
    updateData: (
      entries: Entries<DataType>,
      deletedKeys: Record<string, number>
    ) => void
  ) {
    updateData(this.entries, this.deletedKeys);
    updateData(this.updates.entries, this.updates.deletedKeys);
    this.onEntriesUpdate();
  }

  clear() {
    this.entries = {};
    this.deletedKeys = {};
    this.updates = { entries: {}, deletedKeys: {} };
    this.onEntriesUpdate();
  }

  subscribe(fn: () => any) {
    this.subscribers.push(fn);
    return () => (this.subscribers = this.subscribers.filter((f) => f !== fn));
  }

  get<ReturnType>(fn: ComputedPropertyFunction<DataType, ReturnType>): ReturnType {
    if (this.cachedComputedProperties.has(fn)) {
      return this.cachedComputedProperties.get(fn);
    }

    const value = fn(this.entries);
    this.cachedComputedProperties.set(fn, value);
    return value;
  }

  private onEntriesUpdate() {
    this.cachedHash = '';
    this.cachedComputedProperties.clear();
    this.subscribers.forEach((fn) => fn());
  }

  getUpdates() {
    return this.updates;
  }

  clearUpdates(alreadySyncedUpdates?: Updates<DataType>) {
    if (alreadySyncedUpdates) {
      // Clear updates that have already been synced with API
      Object.entries(alreadySyncedUpdates.entries).forEach(
        ([key, [timestamp, value]]) => {
          const [updateTimestamp, updateValue] = this.updates.entries[key];
          if (updateTimestamp === timestamp && updateValue === value) {
            delete this.updates.entries[key];
          }
        }
      );
      Object.entries(alreadySyncedUpdates.deletedKeys).forEach(([key, timestamp]) => {
        const updateTimestamp = this.updates.deletedKeys[key];
        if (updateTimestamp === timestamp) {
          delete this.updates.deletedKeys[key];
        }
      });
    } else {
      // Clear all updates
      this.updates = { entries: {}, deletedKeys: {} };
    }
  }

  export() {
    return JSON.stringify({
      entries: this.entries,
      deletedKeys: this.deletedKeys,
    });
  }

  import(data: string | Updates<DataType>, clearBeforeImporting = true) {
    // Parse JSON if necessary
    const { entries, deletedKeys } = typeof data === 'string' ? JSON.parse(data) : data;
    if (!entries || typeof entries !== 'object')
      throw new Error('Invalid imported entries');
    if (!deletedKeys || typeof deletedKeys !== 'object')
      throw new Error('Invalid imported deletedKeys');

    // Clear data before importing
    if (clearBeforeImporting) this.clear();

    // Import data
    Object.entries(entries as Record<string, EntryValue<DataType>>).forEach(
      ([key, arr]) => {
        try {
          this.add(key, arr[0], arr[1] === undefined ? this.defaultValue : arr[1]);
        } catch (err) {
          console.warn('Invalid imported entry', key, arr);
        }
      }
    );
    Object.entries(deletedKeys as Record<string, number>).forEach(
      ([key, timestamp]) => {
        if (!isPositiveInteger(timestamp)) {
          return console.warn('Invalid imported deletedKey', key, timestamp);
        }
        if (this.entries[key]) {
          console.warn(
            'Import contains both imported entry and deleted key. Reconciling...',
            key,
            this.entries[key],
            timestamp
          );
          try {
            this.remove(key, timestamp);
          } catch (err) {}
        } else {
          this.deletedKeys[key] = timestamp;
        }
      }
    );
  }

  // Compute hash only when requested and re-use cached value when possible
  get hash() {
    this.cachedHash =
      this.cachedHash || this.hashFunction(JSON.stringify(this.entries));
    return this.cachedHash;
  }
}

//
// HELPERS
//

function simpleHash(str: string) {
  return hashCode(str).toString();
}

// https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function isPositiveInteger(value: any) {
  return value > 0 && Number.isInteger(value);
}
